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

/** Only numeric slots enter the real partial index; null/missing do not. */
function isIndexedSlot(value) {
  return typeof value === 'number';
}

/**
 * Minimal in-memory stand-in for the tuitions collection. It enforces the
 * same partial unique `{ tutorId, tutorSlot }` rule as the real index, so
 * concurrent inserts can be exercised without a live MongoDB.
 */
/**
 * Deterministic TOCTOU harness: both requests read the same count, then the
 * second slot read resolves only after the first request has inserted. This
 * reproduces the real-world interleaving where a stale count lets a second
 * request choose slot 3 unless the fallback collides with an occupied slot.
 */
function createInterleavedTuitions(tutorId) {
  const documents = [{ title: 'Existing', tutorId, tutorSlot: 1 }];
  let releaseSecondRead = () => {};
  const secondRead = new Promise((resolve) => {
    releaseSecondRead = resolve;
  });
  let findCalls = 0;
  let insertCalls = 0;

  return {
    documents,
    async countDocuments() {
      return documents.length;
    },
    find(filter) {
      findCalls += 1;
      const isSecondRead = findCalls === 2;

      return {
        async toArray() {
          // The second request reads occupied slots only after the first
          // request has committed its insert.
          if (isSecondRead) await secondRead;
          return documents.filter(
            (document) =>
              String(document.tutorId) === String(filter.tutorId) &&
              isIndexedSlot(document.tutorSlot)
          );
        },
      };
    },
    async insertOne(document) {
      insertCalls += 1;

      const duplicate =
        isIndexedSlot(document.tutorSlot) &&
        documents.some(
          (existing) =>
            String(existing.tutorId) === String(document.tutorId) &&
            isIndexedSlot(existing.tutorSlot) &&
            existing.tutorSlot === document.tutorSlot
        );

      if (duplicate) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }

      documents.push(document);

      if (insertCalls === 1) releaseSecondRead();
    },
  };
}

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
              isIndexedSlot(document.tutorSlot)
          );
        },
      };
    },
    async insertOne(document) {
      // Yield so Promise.all() requests genuinely interleave.
      await Promise.resolve();

      const duplicate =
        isIndexedSlot(document.tutorSlot) &&
        documents.some(
          (existing) =>
            String(existing.tutorId) === String(document.tutorId) &&
            isIndexedSlot(existing.tutorSlot) &&
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

test('free plan slot index is a unique partial index on numeric tutorSlot', () => {
  const { keys, options } = buildTutorSlotIndexSpec();

  assert.deepEqual(keys, { tutorId: 1, tutorSlot: 1 });
  assert.equal(options.unique, true);
  assert.equal(options.sparse, undefined);
  assert.deepEqual(options.partialFilterExpression, {
    tutorSlot: { $type: 'number' },
  });
  assert.equal(options.name, 'uniq_tutor_tuition_slot');
  assert.equal(FREE_PLAN_POST_LIMIT, 2);
});

test('slot selection uses 1 then 2 and never silently exceeds the limit', () => {
  assert.equal(chooseTutorSlot(new Set()), 1);
  assert.equal(chooseTutorSlot(new Set([1])), 2);
  assert.equal(chooseTutorSlot(new Set([2])), 1);
  // A full set must resolve to an occupied slot so the unique index rejects
  // the insert; a fresh value such as 3 would be a valid partial-index key.
  assert.equal(chooseTutorSlot(new Set([1, 2])), 1);
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

test('a stale count cannot give a concurrent free post a third slot', async () => {
  const tutorId = new ObjectId();
  const tuitions = createInterleavedTuitions(tutorId);

  const first = insertTuitionWithLimit({
    tuitions,
    tutorId,
    isPro: false,
    document: { title: 'First', tutorId },
  });
  const second = insertTuitionWithLimit({
    tuitions,
    tutorId,
    isPro: false,
    document: { title: 'Second', tutorId },
  });

  const results = await Promise.all([first, second]);

  assert.equal(tuitions.documents.length, FREE_PLAN_POST_LIMIT);
  assert.deepEqual(
    tuitions.documents.map((document) => document.tutorSlot).sort(),
    [1, 2]
  );
  assert.equal(results.filter((result) => result.limited).length, 1);
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

test('pro tuitions with an explicit null tutorSlot never collide', async () => {
  const tuitions = createFakeTuitions();
  const tutorId = new ObjectId();

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      insertTuitionWithLimit({
        tuitions,
        tutorId,
        isPro: true,
        document: { title: `Pro ${index}`, tutorId, tutorSlot: null },
      })
    )
  );

  assert.equal(tuitions.documents.length, 6);
  assert.equal(results.every((result) => result.inserted), true);
  assert.equal(
    tuitions.documents.every((document) => document.tutorSlot === null),
    true
  );
});

test('a null pro slot does not consume a free slot', async () => {
  const tuitions = createFakeTuitions();
  const tutorId = new ObjectId();

  await insertTuitionWithLimit({
    tuitions,
    tutorId,
    isPro: true,
    document: { title: 'Pro', tutorId, tutorSlot: null },
  });

  const first = await insertTuitionWithLimit({
    tuitions,
    tutorId,
    isPro: false,
    document: { title: 'Free 1', tutorId },
  });

  assert.equal(first.inserted.tutorSlot, 1);

  const second = await insertTuitionWithLimit({
    tuitions,
    tutorId,
    isPro: false,
    document: { title: 'Free 2', tutorId },
  });

  assert.deepEqual(second, { limited: true });
  assert.equal(tuitions.documents.length, 2);
});
