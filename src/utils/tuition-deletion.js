import { getDb } from '../config/db.js';

/**
 * Shared cleanup for deleting a single tuition post.
 *
 * A tuition is referenced by:
 * - `applications.tuitionId`
 * - `user.savedTuitionIds`
 *
 * Both references are removed in the SAME MongoDB transaction as the tuition
 * delete, so a crash or a concurrent race can never leave dangling ids.
 * Payments are not linked to individual tuitions and are intentionally never
 * touched.
 */

/** Thrown internally when a concurrent delete removed the tuition first. */
class TuitionDeleteRaceError extends Error {
  constructor() {
    super('Tuition was removed by a concurrent request');
  }
}

/** Ownership-scoped filter for the tuition being deleted. */
export function buildTuitionDeleteFilter(tuitionId, tutorId = null) {
  const filter = { _id: tuitionId };

  if (tutorId) {
    filter.tutorId = tutorId;
  }

  return filter;
}

/**
 * Deletes one tuition and every reference to it inside a single transaction.
 * Returns null when the tuition does not exist (or is not owned by `tutorId`).
 *
 * `session` may be supplied by a caller that already owns a transaction;
 * otherwise a session is started from the connected MongoClient (`db.client`)
 * and always ended after commit/abort. No connection settings are changed.
 */
export async function deleteTuitionWithReferences(
  tuitionId,
  { tutorId = null, db = getDb(), session = null } = {}
) {
  const perform = async (activeSession) => {
    const options = activeSession ? { session: activeSession } : {};
    const tuitions = db.collection('tuitions');
    const applications = db.collection('applications');
    const users = db.collection('user');
    const filter = buildTuitionDeleteFilter(tuitionId, tutorId);

    const existing = await tuitions.findOne(filter, {
      projection: { _id: 1 },
      ...options,
    });

    if (!existing) {
      return null;
    }

    const applicationsResult = await applications.deleteMany(
      { tuitionId },
      options
    );

    // Saved ids are normally ObjectIds, but legacy data can contain the string
    // form. Remove both so no dangling reference survives the delete.
    const bookmarkValues = [tuitionId, tuitionId.toString()];
    const usersResult = await users.updateMany(
      { savedTuitionIds: { $in: bookmarkValues } },
      { $pull: { savedTuitionIds: { $in: bookmarkValues } } },
      options
    );
    const tuitionResult = await tuitions.deleteOne(filter, options);

    if (tuitionResult.deletedCount === 0) {
      // Abort the transaction so the cleanup above cannot be committed without
      // the tuition itself being removed.
      throw new TuitionDeleteRaceError();
    }

    return {
      id: tuitionId.toString(),
      deletedApplications: applicationsResult.deletedCount,
      removedBookmarkReferences: usersResult.modifiedCount,
    };
  };

  if (session) {
    try {
      return await perform(session);
    } catch (error) {
      if (error instanceof TuitionDeleteRaceError) return null;
      throw error;
    }
  }

  const client = db.client;

  if (!client || typeof client.startSession !== 'function') {
    throw new Error('MongoDB client with transaction support is required');
  }

  const txSession = client.startSession();

  try {
    let result;

    await txSession.withTransaction(async () => {
      result = await perform(txSession);
    });

    return result;
  } catch (error) {
    if (error instanceof TuitionDeleteRaceError) return null;
    throw error;
  } finally {
    await txSession.endSession();
  }
}
