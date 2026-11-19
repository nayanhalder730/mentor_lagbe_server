import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';
import {
  verifyToken,
  verifyStudent,
  verifyTutor,
} from '../middleware/auth.middleware.js';
import {
  buildCancelApplicationFilter,
  buildOwnedApplicationFilter,
  getCancellationOutcome,
  parseApplicationId,
} from '../utils/application-cancellation.js';

const APPLICATIONS_COLLECTION = 'applications';
const TUITIONS_COLLECTION = 'tuitions';
const USERS_COLLECTION = 'user';

const APPLICATION_STATUSES = new Set(['pending', 'accepted', 'rejected']);
const REVIEW_STATUSES = new Set(['accepted', 'rejected']);

const CREATE_FIELDS = new Set([
  'tuitionId',
  'preferredSchedule',
  'studentPhone',
  'studentNote',
]);

// Student/tutor-facing shape. Internal ownership ids and review metadata
// (`studentId`, `tutorId`, `reviewedAt`) are never exposed.
const APPLICATION_PROJECTION = {
  tuitionId: 1,
  tuitionTitle: 1,
  subject: 1,
  monthlyFee: 1,
  tutorEmail: 1,
  studentName: 1,
  studentEmail: 1,
  studentPhone: 1,
  preferredSchedule: 1,
  studentNote: 1,
  status: 1,
  appliedAt: 1,
};

const router = Router();

let applicationIndexPromise = null;

function applicationsCollection() {
  return getDb().collection(APPLICATIONS_COLLECTION);
}

function tuitionsCollection() {
  return getDb().collection(TUITIONS_COLLECTION);
}

function usersCollection() {
  return getDb().collection(USERS_COLLECTION);
}

/**
 * Creates the compound unique index that guarantees one application per
 * student per tuition, even under concurrent requests. The promise is cached
 * so the index is only created once per process; failures reset the cache so
 * a later request can retry instead of permanently failing.
 */
function ensureApplicationIndex() {
  if (!applicationIndexPromise) {
    applicationIndexPromise = applicationsCollection()
      .createIndex(
        { studentId: 1, tuitionId: 1 },
        { unique: true, name: 'uniq_student_tuition' }
      )
      .catch((error) => {
        applicationIndexPromise = null;
        throw error;
      });
  }

  return applicationIndexPromise;
}

function toObjectId(id) {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) {
    return null;
  }

  return new ObjectId(id);
}

function idsEqual(left, right) {
  if (!left || !right) {
    return false;
  }

  return left.toString() === right.toString();
}

function toApplicationResponse(document) {
  return {
    id: document._id.toString(),
    tuitionId: document.tuitionId.toString(),
    tuitionTitle: document.tuitionTitle,
    subject: document.subject,
    monthlyFee: document.monthlyFee,
    tutorEmail: document.tutorEmail,
    studentName: document.studentName,
    studentEmail: document.studentEmail,
    studentPhone: document.studentPhone,
    preferredSchedule: document.preferredSchedule,
    studentNote: document.studentNote ?? null,
    status: document.status,
    appliedAt: document.appliedAt ?? null,
  };
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Validates the create-application body. Only the four student-controlled
 * fields are accepted; tuition and student identity are filled from MongoDB.
 */
function validateCreateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  if (Object.keys(body).length === 0) {
    return { error: 'No application fields provided' };
  }

  if (Object.keys(body).some((key) => !CREATE_FIELDS.has(key))) {
    return {
      error:
        'Only tuitionId, preferredSchedule, studentPhone, and studentNote can be set',
    };
  }

  const missing = ['tuitionId', 'preferredSchedule', 'studentPhone'].filter(
    (field) => body[field] === undefined
  );

  if (missing.length > 0) {
    return { error: `Missing required field(s): ${missing.join(', ')}` };
  }

  if (typeof body.tuitionId !== 'string' || !ObjectId.isValid(body.tuitionId)) {
    return { error: 'tuitionId must be a valid tuition id' };
  }

  if (typeof body.preferredSchedule !== 'string') {
    return { error: 'preferredSchedule must be a string' };
  }

  const preferredSchedule = body.preferredSchedule.trim();

  if (preferredSchedule.length < 3 || preferredSchedule.length > 200) {
    return {
      error: 'preferredSchedule must be between 3 and 200 characters',
    };
  }

  if (typeof body.studentPhone !== 'string') {
    return { error: 'studentPhone must be a string' };
  }

  const studentPhone = body.studentPhone.trim();

  if (studentPhone.length < 6 || studentPhone.length > 30) {
    return { error: 'studentPhone must be between 6 and 30 characters' };
  }

  let studentNote = null;

  if (body.studentNote !== undefined && body.studentNote !== null) {
    if (typeof body.studentNote !== 'string') {
      return { error: 'studentNote must be a string or null' };
    }

    const trimmedNote = body.studentNote.trim();
    studentNote = trimmedNote === '' ? null : trimmedNote;

    if (studentNote !== null && studentNote.length > 1000) {
      return { error: 'studentNote must be at most 1000 characters' };
    }
  }

  return {
    values: {
      tuitionId: new ObjectId(body.tuitionId),
      preferredSchedule,
      studentPhone,
      studentNote,
    },
  };
}

/**
 * POST /api/applications
 * Students apply to a public (approved + active) tuition. Tuition details and
 * student identity are copied from MongoDB, never from the request body.
 */
router.post('/', verifyToken, verifyStudent, async (req, res) => {
  const validated = validateCreateBody(req.body);

  if (validated.error) {
    return res.status(400).json({
      success: false,
      message: validated.error,
    });
  }

  const studentId = toObjectId(req.user.id);

  if (!studentId) {
    return res.status(404).json({
      success: false,
      message: 'Student profile not found',
    });
  }

  const student = await usersCollection().findOne(
    { _id: studentId },
    { projection: { name: 1, email: 1 } }
  );

  if (!student) {
    return res.status(404).json({
      success: false,
      message: 'Student profile not found',
    });
  }

  const { tuitionId, preferredSchedule, studentPhone, studentNote } =
    validated.values;

  const tuition = await tuitionsCollection().findOne(
    { _id: tuitionId, approvalStatus: 'approved', isActive: true },
    {
      projection: {
        title: 1,
        subject: 1,
        monthlyFee: 1,
        tutorEmail: 1,
        tutorId: 1,
      },
    }
  );

  // Pending, rejected, inactive, and missing tuitions are indistinguishable
  // to students so unpublished tuition details cannot be enumerated.
  if (!tuition) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  if (idsEqual(tuition.tutorId, studentId)) {
    return res.status(403).json({
      success: false,
      message: 'You cannot apply to your own tuition',
    });
  }

  const collection = applicationsCollection();

  // The unique index is required for correctness; create it before the
  // duplicate check so concurrent submissions cannot slip through.
  await ensureApplicationIndex();

  const duplicate = await collection.findOne(
    { studentId, tuitionId },
    { projection: { _id: 1 } }
  );

  if (duplicate) {
    return res.status(409).json({
      success: false,
      message: 'You have already applied to this tuition',
    });
  }

  const document = {
    tuitionId: tuition._id,
    tuitionTitle: tuition.title,
    subject: tuition.subject,
    monthlyFee: tuition.monthlyFee,
    tutorEmail: tuition.tutorEmail,
    studentName: student.name ?? '',
    studentEmail: student.email ?? '',
    studentPhone,
    preferredSchedule,
    studentNote,
    status: 'pending',
    appliedAt: new Date(),
    studentId,
    tutorId: tuition.tutorId,
  };

  try {
    await collection.insertOne(document);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'You have already applied to this tuition',
      });
    }

    throw error;
  }

  return res.status(201).json({
    success: true,
    message: 'Application submitted successfully',
    data: toApplicationResponse(document),
  });
});

/**
 * GET /api/applications/my
 * The authenticated student's own applications, newest first.
 */
router.get('/my', verifyToken, verifyStudent, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 20);

  if (page === null) {
    return res.status(400).json({
      success: false,
      message: 'page must be a positive integer',
    });
  }

  if (limit === null || limit > 100) {
    return res.status(400).json({
      success: false,
      message: 'limit must be a positive integer between 1 and 100',
    });
  }

  const studentId = toObjectId(req.user.id);

  if (!studentId) {
    return res.status(404).json({
      success: false,
      message: 'Student profile not found',
    });
  }

  const filter = { studentId };
  const collection = applicationsCollection();
  const total = await collection.countDocuments(filter);
  const applications = await collection
    .find(filter, { projection: APPLICATION_PROJECTION })
    .sort({ appliedAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return res.json({
    success: true,
    message: 'Applications retrieved successfully',
    data: {
      applications: applications.map(toApplicationResponse),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
});

/**
 * GET /api/applications/tutor
 * Applications for tuitions owned by the authenticated tutor, with optional
 * status filtering and pagination.
 */
router.get('/tutor', verifyToken, verifyTutor, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 20);

  if (page === null) {
    return res.status(400).json({
      success: false,
      message: 'page must be a positive integer',
    });
  }

  if (limit === null || limit > 100) {
    return res.status(400).json({
      success: false,
      message: 'limit must be a positive integer between 1 and 100',
    });
  }

  const tutorId = toObjectId(req.user.id);

  if (!tutorId) {
    return res.status(404).json({
      success: false,
      message: 'Tutor profile not found',
    });
  }

  const filter = { tutorId };

  if (req.query.status !== undefined) {
    if (
      typeof req.query.status !== 'string' ||
      !APPLICATION_STATUSES.has(req.query.status)
    ) {
      return res.status(400).json({
        success: false,
        message: 'status must be one of: pending, accepted, rejected',
      });
    }

    filter.status = req.query.status;
  }

  const collection = applicationsCollection();
  const total = await collection.countDocuments(filter);
  const applications = await collection
    .find(filter, { projection: APPLICATION_PROJECTION })
    .sort({ appliedAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return res.json({
    success: true,
    message: 'Applications retrieved successfully',
    data: {
      applications: applications.map(toApplicationResponse),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
});

/**
 * PATCH /api/applications/:id/status
 * Only the tutor who owns the related tuition can review a pending
 * application. Ownership and the pending state are re-checked in the update
 * filter so the transition is atomic.
 */
router.patch('/:id/status', verifyToken, verifyTutor, async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      message: 'Request body must be a JSON object',
    });
  }

  if (Object.keys(body).length !== 1 || !('status' in body)) {
    return res.status(400).json({
      success: false,
      message: 'Only status can be updated',
    });
  }

  if (typeof body.status !== 'string' || !REVIEW_STATUSES.has(body.status)) {
    return res.status(400).json({
      success: false,
      message: 'status must be either accepted or rejected',
    });
  }

  const applicationId = toObjectId(req.params.id);
  const tutorId = toObjectId(req.user.id);

  if (!applicationId || !tutorId) {
    return res.status(404).json({
      success: false,
      message: 'Application not found',
    });
  }

  const collection = applicationsCollection();
  const application = await collection.findOne(
    { _id: applicationId },
    { projection: { tuitionId: 1, tutorId: 1, status: 1 } }
  );

  if (!application || !idsEqual(application.tutorId, tutorId)) {
    // Non-owners receive 404 so application ids cannot be enumerated.
    return res.status(404).json({
      success: false,
      message: 'Application not found',
    });
  }

  const tuition = await tuitionsCollection().findOne(
    { _id: application.tuitionId, tutorId },
    { projection: { _id: 1 } }
  );

  if (!tuition) {
    return res.status(404).json({
      success: false,
      message: 'Application not found',
    });
  }

  if (application.status !== 'pending') {
    return res.status(409).json({
      success: false,
      message: `Only pending applications can be reviewed. This application is already ${application.status}.`,
    });
  }

  const updated = await collection.findOneAndUpdate(
    { _id: applicationId, tutorId, status: 'pending' },
    { $set: { status: body.status, reviewedAt: new Date() } },
    { returnDocument: 'after', projection: APPLICATION_PROJECTION }
  );

  if (!updated) {
    const current = await collection.findOne(
      { _id: applicationId },
      { projection: { status: 1 } }
    );

    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Application not found',
      });
    }

    return res.status(409).json({
      success: false,
      message: `Only pending applications can be reviewed. This application is already ${current.status}.`,
    });
  }

  return res.json({
    success: true,
    message: `Application ${body.status}`,
    data: toApplicationResponse(updated),
  });
});

/**
 * DELETE /api/applications/:id
 * Students cancel only their own pending applications. The student id comes
 * from the verified token, and both ownership and `status: 'pending'` are part
 * of the delete filter so a concurrent tutor decision cannot be bypassed.
 */
router.delete('/:id', verifyToken, verifyStudent, async (req, res) => {
  const applicationId = parseApplicationId(req.params.id);
  const studentId = parseApplicationId(req.user.id);

  if (!applicationId || !studentId) {
    return res.status(404).json({
      success: false,
      message: 'Application not found',
    });
  }

  const collection = applicationsCollection();
  const result = await collection.deleteOne(
    buildCancelApplicationFilter(applicationId, studentId)
  );

  // Non-owners and missing applications are indistinguishable: the lookup is
  // scoped to the same student, so no one else's data is revealed.
  const current =
    result.deletedCount > 0
      ? null
      : await collection.findOne(
          buildOwnedApplicationFilter(applicationId, studentId),
          { projection: { status: 1 } }
        );

  const outcome = getCancellationOutcome(result.deletedCount, current);

  return res.status(outcome.status).json({
    success: outcome.success,
    message: outcome.message,
  });
});

export default router;
