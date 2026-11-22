import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import {
  FREE_PLAN_POST_LIMIT,
  buildTutorSlotIndexSpec,
  buildTuitionLimitResponse,
  chooseTutorSlot,
  insertTuitionWithLimit,
} from '../src/utils/tuition-limit.js';

/**
 * Minimal in-memory stand-in for the tuitions collection. It enforces the
 * same unique `{ tutorId, tutorSlot }` rule as the real sparse index, so
 * concurrent inserts can be exercised without a live MongoDB.
 */
function createFakeTuitions() {
  const documents = [];

  return {
    documents,
    async countDocuments({ tutorId }) {
      return documents.filter(
        (document) => String(document.tutorId) === String(tutorId)
      ).length;
    },
    find(filter) {
      return {
        async toArray() {
          return documents.filter(
            (document) =>
              String(document.tutorId) === String(filter.tutorId) &&
              document.tutorSlot !== undefined
          );
        },
      };
    },
    async insertOne(document) {
      // Yield so Promise.all() requests genuinely interleave.
      await Promise.resolve();

      const duplicate = documents.some(
        (existing) =>
          String(existing.tutorId) === String(document.tutorId) &&
          document.tutorSlot !== undefined &&
          existing.tutorSlot === document.tutorSlot
      );

      if (duplicate) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }

      documents.push(document);
    },
  };
}

test('free plan slot index is unique and sparse on tutorId + tutorSlot', () => {
  const { keys, options } = buildTutorSlotIndexSpec();

  assert.deepEqual(keys, { tutorId: 1, tutorSlot: 1 });
  assert.equal(options.unique, true);
  assert.equal(options.sparse, true);
  assert.equal(options.name, 'uniq_tutor_tuition_slot');
  assert.equal(FREE_PLAN_POST_LIMIT, 2);
});

test('slot selection uses 1 then 2 and never silently exceeds the limit', () => {
  assert.equal(chooseTutorSlot(new Set()), 1);
  assert.equal(chooseTutorSlot(new Set([1])), 2);
  assert.equal(chooseTutorSlot(new Set([2])), 1);
  assert.equal(chooseTutorSlot(new Set([1, 2])), 3);
});

test('limit response is a clear 403 with the existing message', () => {
  const response = buildTuitionLimitResponse();

  assert.equal(response.status, 403);
  assert.equal(response.success, false);
  assert.equal(response.code, 'FREE_TUITION_LIMIT');
  assert.match(response.message, /at most 2 tuitions/i);
});

test('concurrent free-plan creates cannot exceed two posts', async () => {
  const tuitions = createFakeTuitions();
  const tutorId = new ObjectId();

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      insertTuitionWithLimit({
        tuitions,
        tutorId,
        isPro: false,
        document: { title: `Tuition ${index}`, tutorId },
      })
    )
  );

  assert.equal(tuitions.documents.length, FREE_PLAN_POST_LIMIT);
  assert.deepEqual(
    tuitions.documents.map((document) => document.tutorSlot).sort(),
    [1, 2]
  );
  assert.equal(
    results.filter((result) => result.limited).length,
    8 - FREE_PLAN_POST_LIMIT
  );
});

test('free tutor already at the limit is rejected before inserting', async () => {
  const tuitions = createFakeTuitions();
  const tutorId = new ObjectId();

  tuitions.documents.push(
    { title: 'Existing 1', tutorId, tutorSlot: 1 },
    { title: 'Existing 2', tutorId, tutorSlot: 2 }
  );

  const result = await insertTuitionWithLimit({
    tuitions,
    tutorId,
    isPro: false,
    document: { title: 'Third', tutorId },
  });

  assert.deepEqual(result, { limited: true });
  assert.equal(tuitions.documents.length, 2);
});

test('pro tutors remain unlimited and never occupy a free slot', async () => {
  const tuitions = createFakeTuitions();
  const tutorId = new ObjectId();

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      insertTuitionWithLimit({
        tuitions,
        tutorId,
        isPro: true,
        document: { title: `Pro ${index}`, tutorId },
      })
    )
  );

  assert.equal(tuitions.documents.length, 6);
  assert.equal(results.every((result) => result.inserted), true);
  assert.equal(
    tuitions.documents.some((document) => 'tutorSlot' in document),
    false
  );
});
