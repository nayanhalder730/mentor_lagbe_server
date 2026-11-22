import { getDb } from '../config/db.js';

/**
 * Shared cleanup for deleting a single tuition post.
 *
 * A tuition is referenced by:
 * - `applications.tuitionId`
 * - `user.savedTuitionIds`
 *
 * Both references are removed before the tuition document so the public
 * catalogue and dashboards cannot retain dangling ids. Payments are not
 * linked to individual tuitions and are intentionally never touched.
 */

/** Ownership-scoped filter for the tuition being deleted. */
export function buildTuitionDeleteFilter(tuitionId, tutorId = null) {
  const filter = { _id: tuitionId };

  if (tutorId) {
    filter.tutorId = tutorId;
  }

  return filter;
}

/**
 * Deletes one tuition and every reference to it.
 * Returns null when the tuition does not exist (or is not owned by `tutorId`).
 */
export async function deleteTuitionWithReferences(
  tuitionId,
  { tutorId = null, db = getDb() } = {}
) {
  const tuitions = db.collection('tuitions');
  const applications = db.collection('applications');
  const users = db.collection('user');
  const filter = buildTuitionDeleteFilter(tuitionId, tutorId);

  const existing = await tuitions.findOne(filter, { projection: { _id: 1 } });

  if (!existing) {
    return null;
  }

  const applicationsResult = await applications.deleteMany({ tuitionId });
  const usersResult = await users.updateMany(
    { savedTuitionIds: tuitionId },
    { $pull: { savedTuitionIds: tuitionId } }
  );
  const tuitionResult = await tuitions.deleteOne(filter);

  if (tuitionResult.deletedCount === 0) {
    return null;
  }

  return {
    id: tuitionId.toString(),
    deletedApplications: applicationsResult.deletedCount,
    removedBookmarkReferences: usersResult.modifiedCount,
  };
}
