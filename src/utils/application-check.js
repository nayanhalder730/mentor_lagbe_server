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
