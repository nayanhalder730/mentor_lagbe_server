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

export const FREE_STUDENT_SAVE_LIMIT = 5;

/**
 * `$ne` plus `$addToSet` makes duplicate saves impossible under concurrency.
 * When maxSaved is provided, `$expr` also makes the Free-plan cap atomic so
 * concurrent saves cannot push a Free student past the limit.
 */
export function buildSaveTuitionUpdate(userId, tuitionId, maxSaved = null) {
  const filter = {
    _id: userId,
    savedTuitionIds: { $ne: tuitionId },
  };

  if (Number.isInteger(maxSaved)) {
    filter.$expr = {
      $lt: [{ $size: { $ifNull: ['$savedTuitionIds', []] } }, maxSaved],
    };
  }

  return {
    filter,
    update: { $addToSet: { savedTuitionIds: tuitionId } },
  };
}

/** Clear, upgrade-oriented response when a Free student hits the cap. */
export function buildSavedTuitionLimitResponse() {
  return {
    status: 403,
    success: false,
    code: 'FREE_BOOKMARK_LIMIT',
    message:
      'Free students can save at most 5 tuitions. Upgrade to Student Pro for unlimited bookmarks.',
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
