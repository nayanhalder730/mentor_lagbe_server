import { ObjectId } from 'mongodb';

/**
 * Efficient, student-scoped application existence check. Identity always comes
 * from the verified JWT; only the requested tuition id is read from the query.
 */

export function parseCheckTuitionId(value) {
  if (typeof value !== 'string' || !ObjectId.isValid(value)) {
    return null;
  }

  return new ObjectId(value);
}

/** Both conditions are required so no other student's row can ever match. */
export function buildApplicationCheckFilter(studentId, tuitionId) {
  return {
    studentId,
    tuitionId,
  };
}

/**
 * Safe payload for the existence check: whether a row exists plus its review
 * status. No ownership ids, contact details or other application fields are
 * returned, and duplicate prevention is unaffected.
 */
export function buildApplicationCheckResponse(existing) {
  return {
    hasApplied: Boolean(existing),
    status: existing?.status ?? null,
  };
}
