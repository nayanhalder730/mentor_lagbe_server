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
} = {}) {
  const calls = [];
  const db = {
    collection(name) {
      return {
        findOne: async (filter, options) => {
          calls.push({ op: 'findOne', name, filter, options });
          return tuition;
        },
        deleteMany: async (filter) => {
          calls.push({ op: 'deleteMany', name, filter });
          return { deletedCount: deletedApplications };
        },
        updateMany: async (filter, update) => {
          calls.push({ op: 'updateMany', name, filter, update });
          return { modifiedCount: modifiedBookmarks };
        },
        deleteOne: async (filter) => {
          calls.push({ op: 'deleteOne', name, filter });
          return { deletedCount: deletedTuitions };
        },
      };
    },
  };

  return { db, calls };
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
  const { db, calls } = createFakeDb();

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
  assert.deepEqual(bookmarkPull.filter, { savedTuitionIds: tuitionId });
  assert.deepEqual(bookmarkPull.update, {
    $pull: { savedTuitionIds: tuitionId },
  });
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
