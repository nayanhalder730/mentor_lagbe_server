/**
 * Tuition moderation/visibility rules.
 *
 * These helpers keep the assignment rules in one place so the routes and the
 * focused tests agree on exactly how a tuition becomes public:
 *
 * - New tuitions start pending review but are active.
 * - Public listings only expose approved AND active tuitions.
 * - Admin approval activates a tuition; rejection deactivates it.
 */

const APPROVAL_STATUSES = new Set(['approved', 'rejected']);

/**
 * Moderation state for a newly created tuition.
 * `isActive` is independent from approval: pending posts may be active, but
 * they are still hidden from public queries until approved.
 */
export function getNewTuitionState() {
  return {
    approvalStatus: 'pending',
    isActive: true,
  };
}

/**
 * Base filter for public tuition queries. A fresh object is returned on every
 * call because the list route adds optional query filters to it.
 */
export function getPublicTuitionFilter() {
  return {
    approvalStatus: 'approved',
    isActive: true,
  };
}

/**
 * Normalizes values returned by distinct() for public filter dropdowns.
 * Only non-empty strings are exposed, deduplicated and sorted case-insensitively.
 */
export function normalizeFilterOptions(values) {
  if (!Array.isArray(values)) return [];

  const seen = new Set();

  return values
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase();

      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/**
 * Moderation update applied by the admin approval endpoint.
 * `approvalStatus` is already validated by the route; the guard here prevents
 * accidental public exposure through an unsupported status.
 */
export function getApprovalUpdate(approvalStatus) {
  if (!APPROVAL_STATUSES.has(approvalStatus)) {
    throw new TypeError(
      'approvalStatus must be either approved or rejected'
    );
  }

  return {
    approvalStatus,
    isActive: approvalStatus === 'approved',
  };
}

/**
 * Validation for the tutor-owned PATCH /api/tuitions/:id/status endpoint.
 * Only the single boolean `isActive` field is accepted; moderation and
 * ownership fields are never writable from the client.
 */
export function validateTutorStatusBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  if (Object.keys(body).length !== 1 || !('isActive' in body)) {
    return { error: 'Only isActive can be updated' };
  }

  if (typeof body.isActive !== 'boolean') {
    return { error: 'isActive must be a boolean' };
  }

  return { value: body.isActive };
}

/**
 * Atomic update for the tutor status endpoint. Ownership and approval are part
 * of the match, so a pending/rejected tuition cannot be activated by a tutor
 * even if a concurrent admin moderation changes in between.
 */
export function buildTutorStatusUpdate(tuitionId, tutorId, isActive) {
  return {
    filter: {
      _id: tuitionId,
      tutorId,
      approvalStatus: 'approved',
    },
    update: { $set: { isActive } },
  };
}

/** Ownership-scoped lookup used only after a failed atomic update. */
export function buildOwnedTuitionFilter(tuitionId, tutorId) {
  return { _id: tuitionId, tutorId };
}

/** Response when the atomic update did not match a document. */
export function describeTutorStatusConflict(current) {
  if (!current) {
    return {
      status: 404,
      success: false,
      message: 'Tuition not found',
    };
  }

  return {
    status: 409,
    success: false,
    message: `Only approved tuitions can change active status. This tuition is ${current.approvalStatus}.`,
  };
}

export function getTutorStatusMessage(isActive) {
  return isActive ? 'Tuition activated' : 'Tuition deactivated';
}
