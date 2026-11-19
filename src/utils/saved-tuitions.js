import { ObjectId } from 'mongodb';

/**
 * Student saved tuitions are stored as `savedTuitionIds` on the existing
 * Better Auth `user` document. No new collection is created and no identity is
 * accepted from the client — every filter below is built from the verified
 * user id supplied by `verifyToken`.
 */

export function parseTuitionId(value) {
  if (typeof value !== 'string' || !ObjectId.isValid(value)) {
    return null;
  }

  return new ObjectId(value);
}

/** `$ne` plus `$addToSet` makes duplicate saves impossible under concurrency. */
export function buildSaveTuitionUpdate(userId, tuitionId) {
  return {
    filter: {
      _id: userId,
      savedTuitionIds: { $ne: tuitionId },
    },
    update: { $addToSet: { savedTuitionIds: tuitionId } },
  };
}

/** Ownership is implicit: only the authenticated user's document is matched. */
export function buildRemoveTuitionUpdate(userId, tuitionId) {
  return {
    filter: { _id: userId },
    update: { $pull: { savedTuitionIds: tuitionId } },
  };
}

/** Only currently public tuitions are ever returned in a saved list. */
export function buildSavedTuitionsFilter(tuitionIds) {
  return {
    _id: { $in: tuitionIds },
    approvalStatus: 'approved',
    isActive: true,
  };
}

/** Defensive normalization of a legacy or malformed savedTuitionIds array. */
export function getSavedTuitionIds(user) {
  if (!user || !Array.isArray(user.savedTuitionIds)) {
    return [];
  }

  return user.savedTuitionIds
    .filter((id) => id && ObjectId.isValid(id))
    .map((id) => id.toString());
}
