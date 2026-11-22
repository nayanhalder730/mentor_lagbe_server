import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import applicationRouter from '../src/routes/application.routes.js';
import {
  verifyStudent,
  verifyToken,
  verifyTutor,
} from '../src/middleware/auth.middleware.js';
import {
  APPLICATION_LIMIT_CODE,
  FREE_STUDENT_APPLICATION_LIMIT,
  buildApplicationLimitResponse,
  buildApplicationSlotIndexSpec,
  chooseApplicationSlot,
  insertApplicationWithLimit,
  isProPlan,
} from '../src/utils/application-limit.js';

function createHandler() {
  const layer = applicationRouter.stack.find(
    (entry) => entry.route?.path === '/' && entry.route.methods.post
  );

  assert.ok(layer, 'POST /api/applications must be registered');

  return layer.route.stack.map((entry) => entry.handle);
}

test('free student application limit is two', () => {
  assert.equal(FREE_STUDENT_APPLICATION_LIMIT, 2);
  assert.equal(isProPlan('pro'), true);
  assert.equal(isProPlan('free'), false);
  assert.equal(isProPlan(undefined), false);
});

test('application limit response is clear and upgrade-oriented', () => {
  const response = buildApplicationLimitResponse();

  assert.equal(response.status, 403);
  assert.equal(response.success, false);
  assert.equal(response.code, APPLICATION_LIMIT_CODE);
  assert.match(response.message, /at most 2 applications/i);
  assert.match(response.message, /Upgrade to Student Pro/i);
});

test('slot index is a unique partial index with a new name', () => {
  const spec = buildApplicationSlotIndexSpec();

  assert.deepEqual(spec.keys, { studentId: 1, applicationSlot: 1 });
  assert.equal(spec.options.unique, true);
  assert.equal(spec.options.sparse, undefined);
  assert.deepEqual(spec.options.partialFilterExpression, {
    applicationSlot: { $type: 'number' },
  });
  assert.equal(spec.options.name, 'uniq_student_application_slot_v2');
});

test('slot selection fills only free slots one and two', () => {
  assert.equal(chooseApplicationSlot([], 0), 1);
  assert.equal(chooseApplicationSlot([1], 1), 2);
  assert.equal(chooseApplicationSlot([2], 1), 1);
  assert.equal(chooseApplicationSlot([1, 2], 2), 3);
});

test('application creation requires a verified student', () => {
  const handlers = createHandler();

  assert.ok(handlers.includes(verifyToken));
  assert.ok(handlers.includes(verifyStudent));
  assert.equal(handlers.includes(verifyTutor), false);
});

/**
 * In-memory stand-in that enforces both real indexes: unique
 * { studentId, tuitionId }, and unique partial { studentId, applicationSlot }
 * where only numeric slots are indexed. Missing/null slots never collide.
 */
function createFakeApplications() {
  const documents = [];
  const same = (left, right) => String(left) === String(right);
  const isIndexedSlot = (value) => typeof value === 'number';

  return {
    documents,
    async countDocuments({ studentId }) {
      return documents.filter((doc) => same(doc.studentId, studentId)).length;
    },
    find(filter) {
      return {
        async toArray() {
          return documents.filter(
            (doc) =>
              same(doc.studentId, filter.studentId) &&
              isIndexedSlot(doc.applicationSlot)
          );
        },
      };
    },
    async findOne(filter) {
      return (
        documents.find(
          (doc) =>
            same(doc.studentId, filter.studentId) &&
            same(doc.tuitionId, filter.tuitionId)
        ) ?? null
      );
    },
    async insertOne(document) {
      // Yield so Promise.all() requests genuinely interleave.
      await Promise.resolve();

      const duplicateTuition = documents.some(
        (doc) =>
          same(doc.studentId, document.studentId) &&
          same(doc.tuitionId, document.tuitionId)
      );
      const duplicateSlot =
        isIndexedSlot(document.applicationSlot) &&
        documents.some(
          (doc) =>
            same(doc.studentId, document.studentId) &&
            isIndexedSlot(doc.applicationSlot) &&
            doc.applicationSlot === document.applicationSlot
        );

      if (duplicateTuition || duplicateSlot) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }

      documents.push(document);
    },
  };
}

test('one pro student can apply to two different tuitions', async () => {
  const applications = createFakeApplications();
  const studentId = new ObjectId();
  const tuitionIds = [new ObjectId(), new ObjectId()];

  const results = [];

  for (const tuitionId of tuitionIds) {
    results.push(
      await insertApplicationWithLimit({
        applications,
        studentId,
        tuitionId,
        isPro: true,
        document: { tuitionId, studentId },
      })
    );
  }

  assert.equal(applications.documents.length, 2);
  assert.equal(results.every((result) => result.inserted), true);
  assert.equal(
    applications.documents.some((doc) => 'applicationSlot' in doc),
    false
  );
});

test('multiple pro applications with explicit null slots never collide', async () => {
  const applications = createFakeApplications();
  const studentId = new ObjectId();

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) => {
      const tuitionId = new ObjectId();

      return insertApplicationWithLimit({
        applications,
        studentId,
        tuitionId,
        isPro: true,
        document: { tuitionId, studentId, applicationSlot: null },
      });
    })
  );

  assert.equal(applications.documents.length, 6);
  assert.equal(results.every((result) => result.inserted), true);
  assert.equal(
    applications.documents.every((doc) => doc.applicationSlot === null),
    true
  );
});

test('free students remain limited to exactly two applications', async () => {
  const applications = createFakeApplications();
  const studentId = new ObjectId();

  const results = [];

  for (let index = 0; index < 4; index += 1) {
    const tuitionId = new ObjectId();

    results.push(
      await insertApplicationWithLimit({
        applications,
        studentId,
        tuitionId,
        isPro: false,
        document: { tuitionId, studentId },
      })
    );
  }

  assert.equal(applications.documents.length, 2);
  assert.deepEqual(
    applications.documents.map((doc) => doc.applicationSlot).sort(),
    [1, 2]
  );
  assert.equal(results.filter((result) => result.limited).length, 2);
});

test('concurrent free applications cannot exceed the limit', async () => {
  const applications = createFakeApplications();
  const studentId = new ObjectId();

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => {
      const tuitionId = new ObjectId();

      return insertApplicationWithLimit({
        applications,
        studentId,
        tuitionId,
        isPro: false,
        document: { tuitionId, studentId },
      });
    })
  );

  assert.equal(applications.documents.length, FREE_STUDENT_APPLICATION_LIMIT);
  assert.deepEqual(
    applications.documents.map((doc) => doc.applicationSlot).sort(),
    [1, 2]
  );
  assert.equal(
    results.filter((result) => result.limited).length,
    8 - FREE_STUDENT_APPLICATION_LIMIT
  );
});

test('a duplicate application to the same tuition is still rejected', async () => {
  const applications = createFakeApplications();
  const studentId = new ObjectId();
  const tuitionId = new ObjectId();

  const first = await insertApplicationWithLimit({
    applications,
    studentId,
    tuitionId,
    isPro: true,
    document: { tuitionId, studentId },
  });
  const second = await insertApplicationWithLimit({
    applications,
    studentId,
    tuitionId,
    isPro: true,
    document: { tuitionId, studentId },
  });

  assert.ok(first.inserted);
  assert.deepEqual(second, { duplicate: true });
  assert.equal(applications.documents.length, 1);
});
