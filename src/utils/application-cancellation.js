import { ObjectId } from 'mongodb';

/**
 * Rules for student cancellation of applications.
 *
 * Ownership and the pending state are part of the delete filter itself, not a
 * read-then-delete check. MongoDB matches a single document atomically, so a
 * tutor review that changes the status at the same time cannot be bypassed.
 */

/** Safely parses an application/student id. Never throws on user input. */
export function parseApplicationId(value) {
  if (typeof value !== 'string' || !ObjectId.isValid(value)) {
    return null;
  }

  return new ObjectId(value);
}

/** Atomic filter used by DELETE /api/applications/:id. */
export function buildCancelApplicationFilter(applicationId, studentId) {
  return {
    _id: applicationId,
    studentId,
    status: 'pending',
  };
}

/** Lookup after a failed delete: only ever scoped to the same student. */
export function buildOwnedApplicationFilter(applicationId, studentId) {
  return {
    _id: applicationId,
    studentId,
  };
}

/**
 * Converts the delete result into the response the route should send.
 * `currentApplication` is the ownership-scoped lookup performed only when
 * nothing was deleted.
 */
export function getCancellationOutcome(deletedCount, currentApplication) {
  if (deletedCount > 0) {
    return {
      status: 200,
      success: true,
      message: 'Application cancelled successfully',
    };
  }

  if (!currentApplication) {
    return {
      status: 404,
      success: false,
      message: 'Application not found',
    };
  }

  const status = currentApplication.status;
  const detail =
    status === 'accepted' || status === 'rejected'
      ? ` This application is already ${status}.`
      : '';

  return {
    status: 409,
    success: false,
    message: `Only pending applications can be cancelled.${detail}`,
  };
}
