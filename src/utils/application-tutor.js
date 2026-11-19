import { ObjectId } from 'mongodb';

/**
 * Helpers for enriching a student's application list with the real tutor name.
 *
 * GET /api/applications/my stores `tutorId` on each application. Names live in
 * Better Auth's `user` collection. The route fetches all relevant tutors in a
 * single batched query (`$in`) rather than one query per application.
 */

/** Ownership filter: identity always comes from the verified token. */
export function buildStudentApplicationsFilter(studentId) {
  return { studentId };
}

/** Unique, valid tutor ids needed for one batch lookup. */
export function collectTutorIds(applications) {
  const ids = new Set();

  for (const application of applications) {
    const tutorId = application?.tutorId;

    if (!tutorId) continue;

    const value = tutorId.toString();

    if (ObjectId.isValid(value)) {
      ids.add(value);
    }
  }

  return [...ids];
}

/** Query that fetches every tutor referenced on the current page at once. */
export function buildTutorIdQuery(tutorIds) {
  return { _id: { $in: tutorIds.map((id) => new ObjectId(id)) } };
}

/** Maps tutor documents to names, with null for missing/unnamed accounts. */
export function indexTutorNames(tutors) {
  return new Map(
    tutors
      .filter((tutor) => tutor?._id)
      .map((tutor) => [tutor._id.toString(), tutor.name ?? null])
  );
}

export function getTutorName(application, tutorNamesById) {
  if (!application?.tutorId) {
    return null;
  }

  return tutorNamesById.get(application.tutorId.toString()) ?? null;
}

/**
 * Adds `tutorName` to each existing application response without changing the
 * order, length, or any field produced by the existing response mapper.
 */
export function toStudentApplicationList(
  applications,
  tutors,
  toBaseResponse
) {
  const tutorNamesById = indexTutorNames(tutors);

  return applications.map((application) => ({
    ...toBaseResponse(application),
    tutorName: getTutorName(application, tutorNamesById),
  }));
}
