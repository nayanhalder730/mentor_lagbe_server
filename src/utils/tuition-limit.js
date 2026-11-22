/**
 * Free Tutor tuition-post limit rules.
 *
 * The limit is enforced with a unique PARTIAL index on
 * `{ tutorId, tutorSlot }`. Free posts occupy numeric slot 1 or 2; Pro posts
 * have no slot (or a legacy null slot), so the partial filter keeps them out
 * of the index entirely. A compound *sparse* index is not equivalent: it
 * indexes any document that has `tutorId`, storing `null` for a missing slot,
 * which makes multiple Pro posts for one tutor collide on `{ tutorId, null }`.
 * Concurrent requests race for the same slot and the loser retries the
 * remaining slot instead of both passing a count-then-insert check.
 */

export const FREE_PLAN_POST_LIMIT = 2;
export const TUITION_LIMIT_CODE = 'FREE_TUITION_LIMIT';

/**
 * Unique partial index: only posts carrying a numeric `tutorSlot` are indexed.
 * `$type: 'number'` (not `$exists: true`) also excludes legacy documents that
 * explicitly store `tutorSlot: null`.
 */
export function buildTutorSlotIndexSpec() {
  return {
    keys: { tutorId: 1, tutorSlot: 1 },
    options: {
      unique: true,
      partialFilterExpression: { tutorSlot: { $type: 'number' } },
      name: 'uniq_tutor_tuition_slot',
    },
  };
}

/** Picks a still-free slot for a Free Tutor, 1 or 2. */
export function chooseTutorSlot(usedSlots) {
  for (let slot = 1; slot <= FREE_PLAN_POST_LIMIT; slot += 1) {
    if (!usedSlots.has(slot)) return slot;
  }

  // Both real slots are taken. Return an ALREADY-OCCUPIED slot so the unique
  // index rejects the insert and the caller's next iteration hits the count
  // check, which returns the limit response. A value outside {1, 2} would be
  // a valid distinct key in the partial index and would allow a third post.
  return 1;
}

export function buildTuitionLimitResponse() {
  return {
    status: 403,
    success: false,
    code: TUITION_LIMIT_CODE,
    message:
      'Free tutors can post at most 2 tuitions. Upgrade to Pro for unlimited posts.',
  };
}

export function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

/**
 * Inserts a tuition while enforcing the Free-plan post limit safely under
 * concurrent requests. The caller must have created the unique slot index
 * first (the route does this through ensureTutorSlotIndex()).
 *
 * Returns `{ inserted }` on success or `{ limited: true }` when the Free limit
 * has been reached. Non-duplicate database errors are re-thrown unchanged.
 */
export async function insertTuitionWithLimit({
  tuitions,
  tutorId,
  isPro,
  document,
  limit = FREE_PLAN_POST_LIMIT,
}) {
  const maxAttempts = isPro ? 1 : limit + 1;
  let inserted = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let slot;

    if (!isPro) {
      const existingCount = await tuitions.countDocuments({ tutorId });

      if (existingCount >= limit) {
        return { limited: true };
      }

      const occupied = await tuitions
        .find(
          { tutorId, tutorSlot: { $exists: true } },
          { projection: { tutorSlot: 1 } }
        )
        .toArray();
      const usedSlots = new Set(
        occupied
          .map((entry) => entry.tutorSlot)
          .filter((value) => Number.isInteger(value))
      );

      slot = chooseTutorSlot(usedSlots);
    }

    const candidate =
      slot === undefined ? document : { ...document, tutorSlot: slot };

    try {
      await tuitions.insertOne(candidate);
      inserted = candidate;
      break;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      // Another concurrent request claimed this slot. Recompute and try the
      // remaining slot (or return the limit on the next count check).
    }
  }

  return inserted ? { inserted } : { limited: true };
}
