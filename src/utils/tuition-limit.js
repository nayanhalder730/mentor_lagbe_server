/**
 * Free Tutor tuition-post limit rules.
 *
 * The limit is enforced with a unique sparse index on
 * `{ tutorId, tutorSlot }`. Free posts occupy slot 1 or 2; Pro posts do not
 * carry a slot at all, so the sparse index never constrains them. Concurrent
 * requests race for the same slot and the loser retries the remaining slot
 * instead of both passing a count-then-insert check.
 */

export const FREE_PLAN_POST_LIMIT = 2;
export const TUITION_LIMIT_CODE = 'FREE_TUITION_LIMIT';

/** Unique sparse index: Pro posts have no slot and are unconstrained. */
export function buildTutorSlotIndexSpec() {
  return {
    keys: { tutorId: 1, tutorSlot: 1 },
    options: {
      unique: true,
      sparse: true,
      name: 'uniq_tutor_tuition_slot',
    },
  };
}

/** Picks a still-free slot for a Free Tutor, 1 or 2. */
export function chooseTutorSlot(usedSlots) {
  for (let slot = 1; slot <= FREE_PLAN_POST_LIMIT; slot += 1) {
    if (!usedSlots.has(slot)) return slot;
  }

  // The fallback value cannot match a real slot; the unique index rejects the
  // insert so the caller can retry or return the limit response.
  return FREE_PLAN_POST_LIMIT + 1;
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
