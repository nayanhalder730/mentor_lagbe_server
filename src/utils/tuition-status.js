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
