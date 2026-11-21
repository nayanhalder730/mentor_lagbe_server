/**
 * Free Student application limit rules.
 *
 * The limit is enforced in the Express API using the existing `applications`
 * collection only. `applicationSlot` is an internal occupancy marker for Free
 * accounts; it is never exposed by the public application projection.
 */

export const FREE_STUDENT_APPLICATION_LIMIT = 2;
export const APPLICATION_LIMIT_CODE = 'FREE_APPLICATION_LIMIT';

export function isProPlan(plan) {
  return plan === 'pro';
}

/** Unique sparse index: Pro users have no slot and are unconstrained. */
export function buildApplicationSlotIndexSpec() {
  return {
    keys: { studentId: 1, applicationSlot: 1 },
    options: {
      unique: true,
      sparse: true,
      name: 'uniq_student_application_slot',
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

  // Fallback will violate the unique slot index and trigger a retry/limit
  // response instead of allowing an extra application.
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
