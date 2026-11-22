import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import tuitionRouter, {
  adminTuitionRouter,
} from '../src/routes/tuition.routes.js';
import {
  verifyAdmin,
  verifyToken,
  verifyTutor,
} from '../src/middleware/auth.middleware.js';
import {
  buildTuitionDeleteFilter,
  deleteTuitionWithReferences,
} from '../src/utils/tuition-deletion.js';

function createFakeDb({
  tuition = { _id: new ObjectId() },
  deletedApplications = 2,
  modifiedBookmarks = 1,
  deletedTuitions = 1,
  failOn = null,
} = {}) {
  const calls = [];
  const session = {
    committed: false,
    aborted: false,
    ended: false,
    async withTransaction(fn) {
      try {
        const value = await fn();
        this.committed = true;
        return value;
      } catch (error) {
        this.aborted = true;
        throw error;
      }
    },
    async endSession() {
      this.ended = true;
    },
  };

  const maybeFail = (op) => {
    if (failOn === op) throw new Error(`simulated ${op} failure`);
  };

  const db = {
    client: {
      startSession() {
        return session;
      },
    },
    collection(name) {
      return {
        findOne: async (filter, options) => {
          calls.push({ op: 'findOne', name, filter, options });
          return tuition;
        },
        deleteMany: async (filter, options) => {
          calls.push({ op: 'deleteMany', name, filter, options });
          maybeFail('applications');
          return { deletedCount: deletedApplications };
        },
        updateMany: async (filter, update, options) => {
          calls.push({ op: 'updateMany', name, filter, update, options });
          maybeFail('bookmarks');
          return { modifiedCount: modifiedBookmarks };
        },
        deleteOne: async (filter, options) => {
          calls.push({ op: 'deleteOne', name, filter, options });
          maybeFail('tuition');
          return { deletedCount: deletedTuitions };
        },
      };
    },
  };

  return { db, calls, session };
}

test('tuition delete filter is ownership-scoped for tutors', () => {
  const tuitionId = new ObjectId();
  const tutorId = new ObjectId();

  const owned = buildTuitionDeleteFilter(tuitionId, tutorId);
  const admin = buildTuitionDeleteFilter(tuitionId);

  assert.deepEqual(Object.keys(owned).sort(), ['_id', 'tutorId']);
  assert.equal(String(owned._id), String(tuitionId));
  assert.equal(String(owned.tutorId), String(tutorId));
  assert.deepEqual(Object.keys(admin), ['_id']);
});

test('tutor self-deletion removes applications and bookmark references', async () => {
  const tuitionId = new ObjectId();
  const tutorId = new ObjectId();
  const { db, calls, session } = createFakeDb();

  const result = await deleteTuitionWithReferences(tuitionId, {
    tutorId,
    db,
  });

  assert.equal(result.id, tuitionId.toString());
  assert.equal(result.deletedApplications, 2);
  assert.equal(result.removedBookmarkReferences, 1);

  const applicationDelete = calls.find(
    (call) => call.op === 'deleteMany' && call.name === 'applications'
  );
  const bookmarkPull = calls.find(
    (call) => call.op === 'updateMany' && call.name === 'user'
  );
  const tuitionDelete = calls.find(
    (call) => call.op === 'deleteOne' && call.name === 'tuitions'
  );

  assert.ok(applicationDelete, 'applications must be deleted');
  assert.deepEqual(applicationDelete.filter, { tuitionId });
  assert.ok(bookmarkPull, 'saved bookmark ids must be pulled');
  assert.deepEqual(bookmarkPull.filter, {
    savedTuitionIds: { $in: [tuitionId, tuitionId.toString()] },
  });
  assert.deepEqual(bookmarkPull.update, {
    $pull: { savedTuitionIds: { $in: [tuitionId, tuitionId.toString()] } },
  });
  assert.equal(bookmarkPull.options?.session, session);
  assert.ok(tuitionDelete, 'the tuition itself must be deleted');

  // Ordering keeps references from outliving the tuition lookup.
  assert.ok(
    calls.indexOf(applicationDelete) < calls.indexOf(tuitionDelete),
    'applications must be removed before the tuition document'
  );
  assert.ok(
    calls.indexOf(bookmarkPull) < calls.indexOf(tuitionDelete),
    'bookmarks must be removed before the tuition document'
  );

  assert.equal(
    calls.some((call) => call.name === 'payments'),
    false,
    'payment history must never be touched'
  );
});

test('missing or foreign tuition returns null without deleting anything', async () => {
  const tuitionId = new ObjectId();
  const { db, calls } = createFakeDb({ tuition: null });

  const result = await deleteTuitionWithReferences(tuitionId, { db });

  assert.equal(result, null);
  assert.equal(
    calls.filter((call) => call.op !== 'findOne').length,
    0
  );
});

test('a concurrent second delete does not report a dangling success', async () => {
  const tuitionId = new ObjectId();
  const { db } = createFakeDb({ deletedTuitions: 0 });

  const result = await deleteTuitionWithReferences(tuitionId, { db });

  assert.equal(result, null);
});

test('tutor and admin tuition delete routes keep their role guards', () => {
  const tutorDelete = tuitionRouter.stack.find(
    (entry) => entry.route?.path === '/:id' && entry.route.methods.delete
  );
  const adminDelete = adminTuitionRouter.stack.find(
    (entry) => entry.route?.path === '/:id' && entry.route.methods.delete
  );

  assert.ok(tutorDelete, 'DELETE /api/tuitions/:id must be registered');
  assert.ok(
    adminDelete,
    'DELETE /api/admin/tuitions/:id must be registered'
  );

  const tutorHandlers = tutorDelete.route.stack.map((entry) => entry.handle);
  const adminHandlers = adminDelete.route.stack.map((entry) => entry.handle);

  assert.ok(tutorHandlers.includes(verifyToken));
  assert.ok(tutorHandlers.includes(verifyTutor));
  assert.equal(tutorHandlers.includes(verifyAdmin), false);
  assert.ok(adminHandlers.includes(verifyToken));
  assert.ok(adminHandlers.includes(verifyAdmin));
});

test('cleanup and tuition delete commit in one transaction with the same session', async () => {
  const tuitionId = new ObjectId();
  const tutorId = new ObjectId();
  const { db, calls, session } = createFakeDb();

  const result = await deleteTuitionWithReferences(tuitionId, {
    tutorId,
    db,
  });

  assert.equal(result.id, tuitionId.toString());
  assert.equal(session.committed, true);
  assert.equal(session.aborted, false);
  assert.equal(session.ended, true);

  const writeOps = calls.filter((call) => call.op !== 'findOne');
  assert.equal(writeOps.length, 3);
  assert.equal(
    writeOps.every((call) => call.options?.session === session),
    true,
    'every write must join the same transaction'
  );
  assert.equal(calls[0].options.session, session);
});

test('an application cleanup failure aborts the whole transaction', async () => {
  const { db, calls, session } = createFakeDb({ failOn: 'applications' });

  await assert.rejects(
    deleteTuitionWithReferences(new ObjectId(), { db }),
    /simulated applications failure/
  );

  assert.equal(session.aborted, true);
  assert.equal(session.committed, false);
  assert.equal(session.ended, true);
  assert.equal(
    calls.some((call) => call.op === 'deleteOne'),
    false,
    'the tuition must not be deleted when cleanup fails'
  );
});

test('a bookmark cleanup failure also aborts the transaction', async () => {
  const { db, session } = createFakeDb({ failOn: 'bookmarks' });

  await assert.rejects(
    deleteTuitionWithReferences(new ObjectId(), { db }),
    /simulated bookmarks failure/
  );

  assert.equal(session.aborted, true);
  assert.equal(session.committed, false);
  assert.equal(session.ended, true);
});

test('a lost delete race aborts cleanup instead of committing orphan references', async () => {
  const { db, calls, session } = createFakeDb({ deletedTuitions: 0 });

  const result = await deleteTuitionWithReferences(new ObjectId(), { db });

  assert.equal(result, null);
  assert.equal(session.aborted, true);
  assert.equal(session.committed, false);
  assert.equal(session.ended, true);
  assert.equal(calls.some((call) => call.op === 'deleteOne'), true);
});
