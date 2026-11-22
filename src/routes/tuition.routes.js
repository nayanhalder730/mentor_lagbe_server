import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';
import {
  verifyToken,
  verifyTutor,
  verifyAdmin,
} from '../middleware/auth.middleware.js';
import {
  buildOwnedTuitionFilter,
  buildTutorStatusUpdate,
  describeTutorStatusConflict,
  getApprovalUpdate,
  getNewTuitionState,
  getPublicTuitionFilter,
  getTutorStatusMessage,
  normalizeFilterOptions,
  validateTutorStatusBody,
} from '../utils/tuition-status.js';
import {
  buildTutorSlotIndexSpec,
  buildTuitionLimitResponse,
  insertTuitionWithLimit,
} from '../utils/tuition-limit.js';
import { deleteTuitionWithReferences } from '../utils/tuition-deletion.js';

const TUITIONS_COLLECTION = 'tuitions';
const USERS_COLLECTION = 'user';

const MODES = new Set(['Online', 'Offline']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected']);

const CONTENT_FIELDS = new Set([
  'title',
  'subject',
  'classLevel',
  'mode',
  'location',
  'monthlyFee',
  'daysPerWeek',
  'bannerImage',
  'description',
]);

const REQUIRED_FIELDS = [
  'title',
  'subject',
  'classLevel',
  'mode',
  'location',
  'monthlyFee',
  'daysPerWeek',
  'description',
];

// Public/user-facing shape. Internal `tutorId` and private `tutorEmail` are
// never exposed. Admin routes use ADMIN_TUITION_PROJECTION below.
export const TUITION_PROJECTION = {
  title: 1,
  subject: 1,
  classLevel: 1,
  mode: 1,
  location: 1,
  monthlyFee: 1,
  daysPerWeek: 1,
  bannerImage: 1,
  description: 1,
  tutorName: 1,
  approvalStatus: 1,
  isActive: 1,
  createdAt: 1,
};

/** Admin-only shape: moderation screens may see the tutor's contact email. */
export const ADMIN_TUITION_PROJECTION = {
  ...TUITION_PROJECTION,
  tutorEmail: 1,
};

const router = Router();
export const adminTuitionRouter = Router();

function tuitionsCollection() {
  return getDb().collection(TUITIONS_COLLECTION);
}

function usersCollection() {
  return getDb().collection(USERS_COLLECTION);
}

function toObjectId(id) {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) {
    return null;
  }

  return new ObjectId(id);
}

export function toTuitionResponse(document) {
  return {
    id: document._id.toString(),
    title: document.title,
    subject: document.subject,
    classLevel: document.classLevel,
    mode: document.mode,
    location: document.location,
    monthlyFee: document.monthlyFee,
    daysPerWeek: document.daysPerWeek,
    bannerImage: document.bannerImage ?? null,
    description: document.description,
    tutorName: document.tutorName,
    approvalStatus: document.approvalStatus,
    isActive: document.isActive,
    createdAt: document.createdAt ?? null,
  };
}

/** Admin-only response that additionally exposes the tutor contact email. */
export function toAdminTuitionResponse(document) {
  return {
    ...toTuitionResponse(document),
    tutorEmail: document.tutorEmail ?? null,
  };
}

let tutorSlotIndexPromise = null;

/**
 * Creates the unique `{ tutorId, tutorSlot }` index once per process. The
 * promise is cached so concurrent creates share the same index build; a
 * failure resets the cache so a later request can retry.
 */
function ensureTutorSlotIndex() {
  if (!tutorSlotIndexPromise) {
    const { keys, options } = buildTutorSlotIndexSpec();

    tutorSlotIndexPromise = tuitionsCollection()
      .createIndex(keys, options)
      .catch((error) => {
        tutorSlotIndexPromise = null;
        throw error;
      });
  }

  return tutorSlotIndexPromise;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function parseOptionalNumber(value) {
  if (value === undefined) {
    return { value: undefined };
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return { error: 'must be a number' };
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return { error: 'must be a number' };
  }

  return { value: parsed };
}

function validateOptionalUrl(value) {
  if (value === null || value === '') {
    return { value: null };
  }

  if (typeof value !== 'string') {
    return { error: 'bannerImage must be a string URL or null' };
  }

  const urlValue = value.trim();

  if (urlValue.length > 2048) {
    return { error: 'bannerImage must be at most 2048 characters' };
  }

  try {
    const url = new URL(urlValue);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: 'bannerImage must be an http(s) URL' };
    }
  } catch {
    return { error: 'bannerImage must be a valid URL' };
  }

  return { value: urlValue };
}

function validateContentField(field, value) {
  switch (field) {
    case 'title':
    case 'subject':
    case 'classLevel':
    case 'location':
    case 'description': {
      if (typeof value !== 'string') {
        return { error: `${field} must be a string` };
      }

      const limits = {
        title: [5, 150],
        subject: [2, 80],
        classLevel: [1, 50],
        location: [2, 120],
        description: [10, 2000],
      };
      const [min, max] = limits[field];
      const trimmed = value.trim();

      if (trimmed.length < min || trimmed.length > max) {
        return {
          error: `${field} must be between ${min} and ${max} characters`,
        };
      }

      return { value: trimmed };
    }
    case 'mode': {
      if (typeof value !== 'string' || !MODES.has(value)) {
        return { error: 'mode must be either Online or Offline' };
      }

      return { value };
    }
    case 'monthlyFee': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: 'monthlyFee must be a number' };
      }

      if (value < 0 || value > 1000000) {
        return { error: 'monthlyFee must be between 0 and 1000000' };
      }

      return { value };
    }
    case 'daysPerWeek': {
      if (!Number.isInteger(value) || value < 1 || value > 7) {
        return { error: 'daysPerWeek must be an integer between 1 and 7' };
      }

      return { value };
    }
    case 'bannerImage':
      return validateOptionalUrl(value);
    default:
      return { error: `unsupported field: ${field}` };
  }
}

/**
 * Validates a create/update body against the allowed tuition content fields,
 * rejecting ownership, moderation, and identity fields.
 */
function validateTuitionBody(body, { requireAll }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  const keys = Object.keys(body);

  if (keys.length === 0) {
    return { error: 'No updatable fields provided' };
  }

  if (keys.some((key) => !CONTENT_FIELDS.has(key))) {
    return {
      error:
        'Only title, subject, classLevel, mode, location, monthlyFee, daysPerWeek, bannerImage, and description can be set',
    };
  }

  const values = {};

  for (const key of keys) {
    const result = validateContentField(key, body[key]);

    if (result.error) {
      return result;
    }

    values[key] = result.value;
  }

  if (requireAll) {
    const missing = REQUIRED_FIELDS.filter((field) => !(field in values));

    if (missing.length > 0) {
      return { error: `Missing required field(s): ${missing.join(', ')}` };
    }
  }

  return { values };
}

async function loadTutorProfile(userId) {
  return usersCollection().findOne(
    { _id: userId },
    { projection: { name: 1, email: 1, plan: 1, image: 1, bio: 1 } }
  );
}

function applyPublicFilters(query) {
  const filter = getPublicTuitionFilter();

  if (query.mode !== undefined) {
    if (typeof query.mode !== 'string' || !MODES.has(query.mode)) {
      return { error: 'mode must be either Online or Offline' };
    }

    filter.mode = query.mode;
  }

  for (const [param, field, maxLength] of [
    ['subject', 'subject', 80],
    ['classLevel', 'classLevel', 50],
    ['location', 'location', 120],
  ]) {
    if (query[param] === undefined) {
      continue;
    }

    if (typeof query[param] !== 'string') {
      return { error: `${param} must be a string` };
    }

    const value = query[param].trim();

    if (value.length > maxLength) {
      return { error: `${param} must be at most ${maxLength} characters` };
    }

    if (value.length > 0) {
      filter[field] = { $regex: escapeRegex(value), $options: 'i' };
    }
  }

  const minFee = parseOptionalNumber(query.minFee);
  const maxFee = parseOptionalNumber(query.maxFee);

  if (minFee.error) {
    return { error: 'minFee must be a number' };
  }

  if (maxFee.error) {
    return { error: 'maxFee must be a number' };
  }

  if (minFee.value !== undefined || maxFee.value !== undefined) {
    filter.monthlyFee = {};

    if (minFee.value !== undefined) {
      if (minFee.value < 0 || minFee.value > 1000000) {
        return { error: 'minFee must be between 0 and 1000000' };
      }

      filter.monthlyFee.$gte = minFee.value;
    }

    if (maxFee.value !== undefined) {
      if (maxFee.value < 0 || maxFee.value > 1000000) {
        return { error: 'maxFee must be between 0 and 1000000' };
      }

      filter.monthlyFee.$lte = maxFee.value;
    }

    if (
      minFee.value !== undefined &&
      maxFee.value !== undefined &&
      minFee.value > maxFee.value
    ) {
      return { error: 'minFee cannot be greater than maxFee' };
    }
  }

  if (query.search !== undefined) {
    if (typeof query.search !== 'string') {
      return { error: 'search must be a string' };
    }

    const search = query.search.trim();

    if (search.length > 100) {
      return { error: 'search must be at most 100 characters' };
    }

    if (search.length > 0) {
      const pattern = { $regex: escapeRegex(search), $options: 'i' };

      filter.$or = [
        { title: pattern },
        { subject: pattern },
        { description: pattern },
        { tutorName: pattern },
      ];
    }
  }

  return { filter };
}

/**
 * GET /api/tuitions
 * Public listing of approved and active tuitions only.
 */
router.get('/', async (req, res) => {
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

  const filtered = applyPublicFilters(req.query);

  if (filtered.error) {
    return res.status(400).json({
      success: false,
      message: filtered.error,
    });
  }

  const collection = tuitionsCollection();
  const total = await collection.countDocuments(filtered.filter);
  const tuitions = await collection
    .find(filtered.filter, { projection: TUITION_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return res.json({
    success: true,
    message: 'Tuitions retrieved successfully',
    data: {
      tuitions: tuitions.map(toTuitionResponse),
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
 * GET /api/tuitions/my
 * All of the authenticated tutor's own tuitions, regardless of status.
 */
router.get('/my', verifyToken, verifyTutor, async (req, res) => {
  const userId = toObjectId(req.user.id);

  if (!userId) {
    return res.status(404).json({
      success: false,
      message: 'Tutor profile not found',
    });
  }

  const tuitions = await tuitionsCollection()
    .find({ tutorId: userId }, { projection: TUITION_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  return res.json({
    success: true,
    message: 'Your tuitions retrieved successfully',
    data: {
      tuitions: tuitions.map(toTuitionResponse),
    },
  });
});

/**
 * GET /api/tuitions/filters
 * Public options for the Browse Tuitions dropdowns. Derived from the same
 * approved+active filter used by the listing endpoint, so no unpublished
 * tuition can influence the options. Registered before /:id.
 */
router.get('/filters', async (req, res) => {
  const filter = getPublicTuitionFilter();
  const [subjects, classLevels] = await Promise.all([
    tuitionsCollection().distinct('subject', filter),
    tuitionsCollection().distinct('classLevel', filter),
  ]);

  return res.json({
    success: true,
    message: 'Filter options retrieved successfully',
    data: {
      subjects: normalizeFilterOptions(subjects),
      classLevels: normalizeFilterOptions(classLevels),
    },
  });
});

/**
 * GET /api/tuitions/:id
 * Public detail for one approved and active tuition.
 */
router.get('/:id', async (req, res) => {
  const tuitionId = toObjectId(req.params.id);

  if (!tuitionId) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  // tutorId is needed only to resolve the public tutor profile; it is never
  // included in the API response by toTuitionResponse().
  const tuition = await tuitionsCollection().findOne(
    { _id: tuitionId, approvalStatus: 'approved', isActive: true },
    { projection: { ...TUITION_PROJECTION, tutorId: 1 } }
  );

  if (!tuition) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  const tutor = tuition.tutorId
    ? await loadTutorProfile(tuition.tutorId)
    : null;

  return res.json({
    success: true,
    message: 'Tuition retrieved successfully',
    data: {
      ...toTuitionResponse(tuition),
      tutorImage: tutor?.image ?? null,
      tutorBio: tutor?.bio ?? null,
    },
  });
});

/**
 * POST /api/tuitions
 * Tutors create a pending, inactive tuition owned by their verified identity.
 */
router.post('/', verifyToken, verifyTutor, async (req, res) => {
  const validated = validateTuitionBody(req.body, { requireAll: true });

  if (validated.error) {
    return res.status(400).json({
      success: false,
      message: validated.error,
    });
  }

  const userId = toObjectId(req.user.id);

  if (!userId) {
    return res.status(404).json({
      success: false,
      message: 'Tutor profile not found',
    });
  }

  const tutor = await loadTutorProfile(userId);

  if (!tutor) {
    return res.status(404).json({
      success: false,
      message: 'Tutor profile not found',
    });
  }

  // Plan is read from trusted database data, never the request body or the
  // (possibly stale) JWT claim.
  const isPro = tutor.plan === 'pro';

  if (!isPro) {
    await ensureTutorSlotIndex();
  }

  const document = {
    ...validated.values,
    bannerImage: validated.values.bannerImage ?? null,
    tutorId: userId,
    tutorName: tutor.name ?? '',
    tutorEmail: tutor.email ?? '',
    ...getNewTuitionState(),
    createdAt: new Date(),
  };

  const outcome = await insertTuitionWithLimit({
    tuitions: tuitionsCollection(),
    tutorId: userId,
    isPro,
    document,
  });

  if (outcome.limited) {
    const limit = buildTuitionLimitResponse();
    return res.status(limit.status).json(limit);
  }

  return res.status(201).json({
    success: true,
    message: 'Tuition created and submitted for approval',
    data: toTuitionResponse(outcome.inserted),
  });
});

/**
 * PATCH /api/tuitions/:id
 * Owners update content. Moderation state and ownership are never accepted
 * from the client; content edits on approved/rejected posts re-enter review.
 */
router.patch('/:id', verifyToken, verifyTutor, async (req, res) => {
  const tuitionId = toObjectId(req.params.id);
  const userId = toObjectId(req.user.id);

  if (!tuitionId || !userId) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  const validated = validateTuitionBody(req.body, { requireAll: false });

  if (validated.error) {
    return res.status(400).json({
      success: false,
      message: validated.error,
    });
  }

  const collection = tuitionsCollection();
  const existing = await collection.findOne(
    { _id: tuitionId },
    { projection: { ...TUITION_PROJECTION, tutorId: 1 } }
  );

  if (!existing || !existing.tutorId || !existing.tutorId.equals(userId)) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  const changedFields = Object.entries(validated.values).filter(
    ([field, value]) => existing[field] !== value
  );

  if (changedFields.length === 0) {
    return res.json({
      success: true,
      message: 'Tuition already up to date',
      data: toTuitionResponse(existing),
    });
  }

  const update = { ...validated.values };
  let resubmitted = false;

  if (
    existing.approvalStatus === 'approved' ||
    existing.approvalStatus === 'rejected'
  ) {
    update.approvalStatus = 'pending';
    update.isActive = false;
    resubmitted = true;
  }

  const updated = await collection.findOneAndUpdate(
    { _id: tuitionId, tutorId: userId },
    { $set: update },
    { returnDocument: 'after', projection: TUITION_PROJECTION }
  );

  if (!updated) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  return res.json({
    success: true,
    message: resubmitted
      ? 'Tuition updated and resubmitted for approval'
      : 'Tuition updated successfully',
    data: toTuitionResponse(updated),
  });
});

/**
 * DELETE /api/tuitions/:id
 * Only the owning tutor may delete their own tuition. Related applications
 * and saved-tuition references are removed in the same operation so no
 * dangling ids remain. Payment history is never touched.
 */
router.delete('/:id', verifyToken, verifyTutor, async (req, res) => {
  const tuitionId = toObjectId(req.params.id);
  const userId = toObjectId(req.user.id);

  if (!tuitionId || !userId) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  const deleted = await deleteTuitionWithReferences(tuitionId, {
    tutorId: userId,
  });

  if (!deleted) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  return res.json({
    success: true,
    message: 'Tuition deleted successfully',
    data: deleted,
  });
});

/**
 * GET /api/admin/tuitions
 * Admin listing of every tuition with pagination and status filtering.
 */
adminTuitionRouter.get('/', verifyToken, verifyAdmin, async (req, res) => {
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

  const filter = {};

  if (req.query.approvalStatus !== undefined) {
    if (
      typeof req.query.approvalStatus !== 'string' ||
      !APPROVAL_STATUSES.has(req.query.approvalStatus)
    ) {
      return res.status(400).json({
        success: false,
        message: 'approvalStatus must be one of: pending, approved, rejected',
      });
    }

    filter.approvalStatus = req.query.approvalStatus;
  }

  if (req.query.search !== undefined) {
    if (typeof req.query.search !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'search must be a string',
      });
    }

    const search = req.query.search.trim();

    if (search.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'search must be at most 100 characters',
      });
    }

    if (search.length > 0) {
      const pattern = { $regex: escapeRegex(search), $options: 'i' };

      filter.$or = [
        { title: pattern },
        { subject: pattern },
        { tutorName: pattern },
        { tutorEmail: pattern },
      ];
    }
  }

  const collection = tuitionsCollection();
  const total = await collection.countDocuments(filter);
  const tuitions = await collection
    .find(filter, { projection: ADMIN_TUITION_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return res.json({
    success: true,
    message: 'Tuitions retrieved successfully',
    data: {
      tuitions: tuitions.map(toAdminTuitionResponse),
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
 * PATCH /api/admin/tuitions/:id/approval
 * Admins move a pending tuition to approved or rejected.
 */
adminTuitionRouter.patch(
  '/:id/approval',
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a JSON object',
      });
    }

    if (Object.keys(body).length !== 1 || !('approvalStatus' in body)) {
      return res.status(400).json({
        success: false,
        message: 'Only approvalStatus can be updated',
      });
    }

    if (
      body.approvalStatus !== 'approved' &&
      body.approvalStatus !== 'rejected'
    ) {
      return res.status(400).json({
        success: false,
        message: 'approvalStatus must be either approved or rejected',
      });
    }

    const tuitionId = toObjectId(req.params.id);

    if (!tuitionId) {
      return res.status(404).json({
        success: false,
        message: 'Tuition not found',
      });
    }

    const collection = tuitionsCollection();
    const existing = await collection.findOne(
      { _id: tuitionId },
      { projection: { approvalStatus: 1, tutorId: 1 } }
    );

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Tuition not found',
      });
    }

    const adminId = toObjectId(req.user.id);

    if (existing.tutorId && adminId && existing.tutorId.equals(adminId)) {
      return res.status(403).json({
        success: false,
        message: 'Admins cannot review their own tuition',
      });
    }

    if (existing.approvalStatus !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Only pending tuitions can be reviewed',
      });
    }

    const approved = body.approvalStatus === 'approved';
    const updated = await collection.findOneAndUpdate(
      { _id: tuitionId },
      { $set: getApprovalUpdate(body.approvalStatus) },
      { returnDocument: 'after', projection: ADMIN_TUITION_PROJECTION }
    );

    return res.json({
      success: true,
      message: approved ? 'Tuition approved' : 'Tuition rejected',
      data: toAdminTuitionResponse(updated),
    });
  }
);

/**
 * PATCH /api/admin/tuitions/:id/status
 * Admins may activate or deactivate an approved tuition only.
 */
adminTuitionRouter.patch(
  '/:id/status',
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a JSON object',
      });
    }

    if (Object.keys(body).length !== 1 || !('isActive' in body)) {
      return res.status(400).json({
        success: false,
        message: 'Only isActive can be updated',
      });
    }

    if (typeof body.isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean',
      });
    }

    const tuitionId = toObjectId(req.params.id);

    if (!tuitionId) {
      return res.status(404).json({
        success: false,
        message: 'Tuition not found',
      });
    }

    const collection = tuitionsCollection();
    const existing = await collection.findOne(
      { _id: tuitionId },
      { projection: { approvalStatus: 1 } }
    );

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Tuition not found',
      });
    }

    if (body.isActive && existing.approvalStatus !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Only approved tuitions can be activated',
      });
    }

    const updated = await collection.findOneAndUpdate(
      { _id: tuitionId },
      { $set: { isActive: body.isActive } },
      { returnDocument: 'after', projection: ADMIN_TUITION_PROJECTION }
    );

    return res.json({
      success: true,
      message: body.isActive
        ? 'Tuition activated'
        : 'Tuition deactivated',
      data: toAdminTuitionResponse(updated),
    });
  }
);

/**
 * DELETE /api/admin/tuitions/:id
 * Admin-only removal of inappropriate posts. Related applications and saved
 * tuition references are cleaned up so no broken references remain. Payments
 * are never touched.
 */
adminTuitionRouter.delete('/:id', verifyToken, verifyAdmin, async (req, res) => {
  const tuitionId = toObjectId(req.params.id);

  if (!tuitionId) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  const deleted = await deleteTuitionWithReferences(tuitionId);

  if (!deleted) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  return res.json({
    success: true,
    message: 'Tuition deleted successfully',
    data: deleted,
  });
});

/**
 * PATCH /api/tuitions/:id/status
 * Tutors activate or deactivate only their own approved tuitions. Ownership
 * and approval are part of the atomic update filter, so a pending/rejected
 * tuition can never be toggled through this endpoint.
 */
router.patch('/:id/status', verifyToken, verifyTutor, async (req, res) => {
  const validated = validateTutorStatusBody(req.body);

  if (validated.error) {
    return res.status(400).json({
      success: false,
      message: validated.error,
    });
  }

  const tuitionId = toObjectId(req.params.id);
  const tutorId = toObjectId(req.user.id);

  if (!tuitionId || !tutorId) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  const { filter, update } = buildTutorStatusUpdate(
    tuitionId,
    tutorId,
    validated.value
  );

  const collection = tuitionsCollection();
  const updated = await collection.findOneAndUpdate(
    filter,
    update,
    { returnDocument: 'after', projection: TUITION_PROJECTION }
  );

  if (!updated) {
    // Ownership-scoped lookup: a different tutor's tuition is indistinguish-
    // able from a missing one. This is only a diagnostic read after the
    // atomic update failed, never a read-then-update sequence.
    const current = await collection.findOne(
      buildOwnedTuitionFilter(tuitionId, tutorId),
      { projection: { approvalStatus: 1 } }
    );

    const conflict = describeTutorStatusConflict(current);

    return res.status(conflict.status).json({
      success: false,
      message: conflict.message,
    });
  }

  return res.json({
    success: true,
    message: getTutorStatusMessage(validated.value),
    data: toTuitionResponse(updated),
  });
});

export default router;
