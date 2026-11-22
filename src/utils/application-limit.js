/**
 * Free Student application limit rules.
 *
 * The limit is enforced with a unique PARTIAL index on
 * `{ studentId, applicationSlot }`. Free applications occupy numeric slot 1 or
 * 2; Pro applications have no slot (or a legacy null slot), so the partial
 * filter keeps them out of the index entirely. A compound *sparse* index is
 * not equivalent: it indexes every document that has `studentId`, storing
 * `null` for a missing slot, which makes multiple Pro applications by one
 * student collide on `{ studentId, null }`.
 */

export const FREE_STUDENT_APPLICATION_LIMIT = 2;
export const APPLICATION_LIMIT_CODE = 'FREE_APPLICATION_LIMIT';

export function isProPlan(plan) {
  return plan === 'pro';
}

/**
 * Unique partial index: only applications carrying a numeric slot are indexed.
 * `$type: 'number'` (not `$exists: true`) also excludes legacy documents that
 * explicitly store `applicationSlot: null`.
 *
 * The name is intentionally new: redefining the old sparse index in place
 * would fail with IndexOptionsConflict (code 85). The old index must be
 * dropped manually, and only after the new code is deployed to every instance.
 */
export function buildApplicationSlotIndexSpec() {
  return {
    keys: { studentId: 1, applicationSlot: 1 },
    options: {
      unique: true,
      partialFilterExpression: { applicationSlot: { $type: 'number' } },
      name: 'uniq_student_application_slot_v2',
    },
  };
}

/** Picks a still-free slot for a Free Student, 1 or 2. */
export function chooseApplicationSlot(usedSlots, existingCount) {
  const used = new Set(usedSlots);

  for (
    let slot = 1;
    slot <= FREE_STUDENT_APPLICATION_LIMIT;
    slot += 1
  ) {
    if (!used.has(slot)) return slot;
  }

  // Reached only after the count check has established existingCount < limit,
  // so this is 1 or 2 — both already occupied. The unique index rejects the
  // insert and the caller retries into the count check (→ limit response).
  // A value of 3 would be a valid key in the partial index and must not be
  // used as a fake collision.
  return existingCount + 1;
}

export function buildApplicationLimitResponse() {
  return {
    status: 403,
    success: false,
    code: APPLICATION_LIMIT_CODE,
    message:
      'Free students can submit at most 2 applications. Upgrade to Student Pro for unlimited applications.',
  };
}

export function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

/**
 * Inserts an application while enforcing the Free-plan limit safely under
 * concurrent requests. The caller must create both indexes first: the unique
 * `{ studentId, tuitionId }` index and the slot index from
 * buildApplicationSlotIndexSpec().
 *
 * Returns `{ inserted }`, `{ limited: true }` or `{ duplicate: true }`.
 * Non-duplicate database errors are re-thrown unchanged.
 */
export async function insertApplicationWithLimit({
  applications,
  studentId,
  tuitionId,
  isPro,
  document,
  limit = FREE_STUDENT_APPLICATION_LIMIT,
}) {
  const maxAttempts = isPro ? 1 : limit + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let slot;

    if (!isPro) {
      const [count, occupied] = await Promise.all([
        applications.countDocuments({ studentId }),
        applications
          .find(
            { studentId, applicationSlot: { $exists: true } },
            { projection: { applicationSlot: 1 } }
          )
          .toArray(),
      ]);

      if (count >= limit) {
        return { limited: true };
      }

      const usedSlots = new Set(
        occupied
          .map((entry) => entry.applicationSlot)
          .filter((value) => Number.isInteger(value))
      );

      slot = chooseApplicationSlot(usedSlots, count);
    }

    const duplicate = await applications.findOne(
      { studentId, tuitionId },
      { projection: { _id: 1 } }
    );

    if (duplicate) {
      return { duplicate: true };
    }

    const candidate =
      slot === undefined ? document : { ...document, applicationSlot: slot };

    try {
      await applications.insertOne(candidate);
      return { inserted: candidate };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const duplicateAfterRace = await applications.findOne(
        { studentId, tuitionId },
        { projection: { _id: 1 } }
      );

      if (duplicateAfterRace || isPro) {
        return { duplicate: true };
      }

      // A Free student's slot was claimed concurrently: recompute from the
      // database on the next attempt.
    }
  }

  return { limited: true };
}
