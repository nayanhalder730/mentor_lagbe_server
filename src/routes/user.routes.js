import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';
import { verifyToken, verifyAdmin, verifyStudent } from '../middleware/auth.middleware.js';
import {
  SAFE_USER_PROJECTION,
  SELF_UPDATABLE_FIELDS,
  USER_ROLES,
  buildRoleChangeUpdate,
  describeRoleChangeConflict,
  describeUserDeleteConflict,
  isAdminDemotion,
  isSelfRoleChange,
  toSafeProfile,
  validateRoleChangeBody,
} from '../utils/user-management.js';
import {
  TUITION_PROJECTION,
  toTuitionResponse,
} from '../routes/tuition.routes.js';
import {
  FREE_STUDENT_SAVE_LIMIT,
  buildRemoveTuitionUpdate,
  buildSaveTuitionUpdate,
  buildSavedTuitionLimitResponse,
  buildSavedTuitionsFilter,
  getSavedTuitionIds,
  parseTuitionId,
} from '../utils/saved-tuitions.js';
import {
  buildAdminLockIndexSpec,
  withAdminLock,
} from '../utils/admin-guard.js';

const router = Router();

// Better Auth's MongoDB adapter stores users in the singular `user` model
// collection and maps its `id` field to MongoDB's `_id`.
const USERS_COLLECTION = 'user';

function usersCollection() {
  return getDb().collection(USERS_COLLECTION);
}

let adminLockIndexPromise = null;

/**
 * Creates the unique admin-mutation lock index once per process. Concurrent
 * role-change/deletion requests share the same build; a failure resets the
 * cache so a later request can retry.
 */
function ensureAdminLockIndex() {
  if (!adminLockIndexPromise) {
    const { keys, options } = buildAdminLockIndexSpec();

    adminLockIndexPromise = usersCollection()
      .createIndex(keys, options)
      .catch((error) => {
        adminLockIndexPromise = null;
        throw error;
      });
  }

  return adminLockIndexPromise;
}

function adminLockContentionResponse(res) {
  return res.status(409).json({
    success: false,
    message: 'Another admin change is in progress. Please try again.',
  });
}

function toObjectId(id) {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) {
    return null;
  }

  return new ObjectId(id);
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

/**
 * Validates one updatable profile field.
 * Returns { value } on success or { error } on invalid input.
 */
function validateField(field, value) {
  switch (field) {
    case 'name': {
      if (typeof value !== 'string') {
        return { error: 'name must be a string' };
      }

      const name = value.trim();

      if (name.length < 1 || name.length > 100) {
        return { error: 'name must be between 1 and 100 characters' };
      }

      return { value: name };
    }
    case 'image': {
      if (value === null || value === '') {
        return { value: null };
      }

      if (typeof value !== 'string') {
        return { error: 'image must be a string URL or null' };
      }

      const image = value.trim();

      if (image.length > 2048) {
        return { error: 'image must be at most 2048 characters' };
      }

      try {
        const url = new URL(image);

        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return { error: 'image must be an http(s) URL' };
        }
      } catch {
        return { error: 'image must be a valid URL' };
      }

      return { value: image };
    }
    case 'phone': {
      if (value === null) {
        return { value: null };
      }

      if (typeof value !== 'string') {
        return { error: 'phone must be a string or null' };
      }

      const phone = normalizeOptionalString(value);

      if (phone === null) {
        return { value: null };
      }

      if (phone.length < 6 || phone.length > 30) {
        return { error: 'phone must be between 6 and 30 characters' };
      }

      return { value: phone };
    }
    case 'bio': {
      if (value === null) {
        return { value: null };
      }

      if (typeof value !== 'string') {
        return { error: 'bio must be a string or null' };
      }

      const bio = normalizeOptionalString(value);

      if (bio !== null && bio.length > 500) {
        return { error: 'bio must be at most 500 characters' };
      }

      return { value: bio };
    }
    default:
      return { error: `unsupported field: ${field}` };
  }
}

/**
 * GET /api/users/me
 * Returns the authenticated user's own safe profile.
 */
router.get('/me', verifyToken, async (req, res) => {
  const userId = toObjectId(req.user.id);

  if (!userId) {
    return res.status(404).json({
      success: false,
      message: 'Profile not found',
    });
  }

  const profile = await usersCollection().findOne(
    { _id: userId },
    { projection: SAFE_USER_PROJECTION }
  );

  if (!profile) {
    return res.status(404).json({
      success: false,
      message: 'Profile not found',
    });
  }

  return res.json({
    success: true,
    message: 'Profile retrieved successfully',
    data: toSafeProfile(profile),
  });
});

/**
 * PATCH /api/users/me
 * Updates only the safe, self-service profile fields. Identity, role, plan,
 * email, and timestamps are never accepted from the request body.
 */
router.patch('/me', verifyToken, async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      message: 'Request body must be a JSON object',
    });
  }

  const bodyFields = Object.keys(body);
  const unsupportedFields = bodyFields.filter((field) => !SELF_UPDATABLE_FIELDS.has(field));

  if (unsupportedFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Only name, image, phone, and bio can be updated',
    });
  }

  if (bodyFields.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No updatable fields provided',
    });
  }

  const updates = {};

  for (const field of bodyFields) {
    const result = validateField(field, body[field]);

    if (result.error) {
      return res.status(400).json({
        success: false,
        message: result.error,
      });
    }

    updates[field] = result.value;
  }

  const userId = toObjectId(req.user.id);

  if (!userId) {
    return res.status(404).json({
      success: false,
      message: 'Profile not found',
    });
  }

  const updatedProfile = await usersCollection().findOneAndUpdate(
    { _id: userId },
    { $set: { ...updates, updatedAt: new Date() } },
    {
      returnDocument: 'after',
      projection: SAFE_USER_PROJECTION,
    }
  );

  if (!updatedProfile) {
    return res.status(404).json({
      success: false,
      message: 'Profile not found',
    });
  }

  return res.json({
    success: true,
    message: 'Profile updated successfully',
    data: toSafeProfile(updatedProfile),
  });
});

function tuitionsCollection() {
  return getDb().collection('tuitions');
}

function applicationsCollection() {
  return getDb().collection('applications');
}

/**
 * GET /api/users/me/saved-tuitions
 * Student-only list of their saved tuitions. Only approved, active tuitions
 * are returned, even if a saved id became unpublished since it was stored.
 */
router.get('/me/saved-tuitions', verifyToken, verifyStudent, async (req, res) => {
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

  const userId = toObjectId(req.user.id);

  if (!userId) {
    return res.status(404).json({
      success: false,
      message: 'Profile not found',
    });
  }

  const user = await usersCollection().findOne(
    { _id: userId },
    { projection: { savedTuitionIds: 1 } }
  );

  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'Profile not found',
    });
  }

  const tuitionIds = getSavedTuitionIds(user).map((id) => new ObjectId(id));
  const filter = buildSavedTuitionsFilter(tuitionIds);
  const collection = tuitionsCollection();
  const total = await collection.countDocuments(filter);
  const tuitions = await collection
    .find(filter, { projection: TUITION_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return res.json({
    success: true,
    message: 'Saved tuitions retrieved successfully',
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
 * POST /api/users/me/saved-tuitions/:tuitionId
 * Student-only save. Identity comes from the JWT; `$ne` + `$addToSet` makes
 * the operation atomic and duplicate-safe.
 */
router.post('/me/saved-tuitions/:tuitionId', verifyToken, verifyStudent, async (req, res) => {
  const tuitionId = parseTuitionId(req.params.tuitionId);
  const userId = toObjectId(req.user.id);

  if (!tuitionId || !userId) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  const tuition = await tuitionsCollection().findOne(
    { _id: tuitionId, approvalStatus: 'approved', isActive: true },
    { projection: { _id: 1 } }
  );

  if (!tuition) {
    return res.status(404).json({
      success: false,
      message: 'Tuition not found',
    });
  }

  // Plan always comes from the database, never from the client. The atomic
  // $expr cap makes the Free limit safe under concurrent requests.
  const account = await usersCollection().findOne(
    { _id: userId },
    { projection: { plan: 1, savedTuitionIds: 1 } }
  );

  if (!account) {
    return res.status(404).json({
      success: false,
      message: 'Student profile not found',
    });
  }

  const isPro = account.plan === 'pro';
  const maxSaved = isPro ? null : FREE_STUDENT_SAVE_LIMIT;

  if (!isPro && getSavedTuitionIds(account).length >= FREE_STUDENT_SAVE_LIMIT) {
    const limit = buildSavedTuitionLimitResponse();
    return res.status(limit.status).json(limit);
  }

  const { filter, update } = buildSaveTuitionUpdate(
    userId,
    tuitionId,
    maxSaved
  );
  const result = await usersCollection().findOneAndUpdate(filter, update, {
    projection: { _id: 1 },
  });

  if (!result) {
    if (!isPro && getSavedTuitionIds(account).length >= FREE_STUDENT_SAVE_LIMIT) {
      const limit = buildSavedTuitionLimitResponse();
      return res.status(limit.status).json(limit);
    }

    return res.status(409).json({
      success: false,
      message: 'Tuition is already saved',
    });
  }

  return res.status(201).json({
    success: true,
    message: 'Tuition saved successfully',
    data: { tuitionId: tuitionId.toString(), saved: true },
  });
});

/**
 * DELETE /api/users/me/saved-tuitions/:tuitionId
 * Removes the id from the authenticated student's own saved list only.
 */
router.delete('/me/saved-tuitions/:tuitionId', verifyToken, verifyStudent, async (req, res) => {
  const tuitionId = parseTuitionId(req.params.tuitionId);
  const userId = toObjectId(req.user.id);

  if (!tuitionId || !userId) {
    return res.status(404).json({
      success: false,
      message: 'Saved tuition not found',
    });
  }

  const { filter, update } = buildRemoveTuitionUpdate(userId, tuitionId);
  const result = await usersCollection().findOneAndUpdate(filter, update, {
    projection: { _id: 1 },
  });

  if (!result) {
    return res.status(404).json({
      success: false,
      message: 'Saved tuition not found',
    });
  }

  return res.json({
    success: true,
    message: 'Tuition removed from saved successfully',
    data: { tuitionId: tuitionId.toString(), saved: false },
  });
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * GET /api/users
 * Admin-only paginated user listing with safe search and role filtering.
 */
router.get('/', verifyToken, verifyAdmin, async (req, res) => {
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

  if (req.query.role !== undefined) {
    if (typeof req.query.role !== 'string' || !USER_ROLES.has(req.query.role)) {
      return res.status(400).json({
        success: false,
        message: 'role must be one of: student, tutor, admin',
      });
    }

    filter.role = req.query.role;
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

      filter.$or = [{ name: pattern }, { email: pattern }];
    }
  }

  const collection = usersCollection();
  const total = await collection.countDocuments(filter);
  const users = await collection
    .find(filter, { projection: SAFE_USER_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return res.json({
    success: true,
    message: 'Users retrieved successfully',
    data: {
      users: users.map(toSafeProfile),
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
 * PATCH /api/users/:id/role
 * Admin-only role changes for student, tutor and admin accounts. An admin
 * cannot change their own role, and the last admin cannot be demoted.
 */
router.patch('/:id/role', verifyToken, verifyAdmin, async (req, res) => {
  const validated = validateRoleChangeBody(req.body);

  if (validated.error) {
    return res.status(400).json({
      success: false,
      message: validated.error,
    });
  }

  const targetId = toObjectId(req.params.id);
  const adminId = toObjectId(req.user.id);

  if (!targetId || !adminId) {
    return res.status(404).json({
      success: false,
      message: 'User not found',
    });
  }

  if (isSelfRoleChange(adminId, targetId)) {
    return res.status(400).json({
      success: false,
      message: 'Admins cannot change their own role',
    });
  }

  await ensureAdminLockIndex();

  const outcome = await withAdminLock(usersCollection(), adminId, async () => {
    const collection = usersCollection();

    const target = await collection.findOne(
      { _id: targetId },
      { projection: { role: 1 } }
    );

    if (!target) {
      return {
        status: 404,
        body: { success: false, message: 'User not found' },
      };
    }

    if (isAdminDemotion(target.role, validated.value)) {
      const adminCount = await collection.countDocuments({ role: 'admin' });

      if (adminCount <= 1) {
        return {
          status: 409,
          body: {
            success: false,
            message: 'Cannot demote the last admin account',
          },
        };
      }
    }

    const { filter, update } = buildRoleChangeUpdate(
      targetId,
      validated.value,
      target.role
    );

    const updated = await collection.findOneAndUpdate(filter, update, {
      returnDocument: 'after',
      projection: SAFE_USER_PROJECTION,
    });

    if (!updated) {
      // Diagnostic read only after the atomic update failed. It never returns
      // another user's profile fields.
      const current = await collection.findOne(
        { _id: targetId },
        { projection: { role: 1 } }
      );
      const conflict = describeRoleChangeConflict(current);

      return {
        status: conflict.status,
        body: { success: false, message: conflict.message },
      };
    }

    return {
      status: 200,
      body: {
        success: true,
        message: 'User role updated successfully',
        data: toSafeProfile(updated),
      },
    };
  });

  if (!outcome.acquired) {
    return adminLockContentionResponse(res);
  }

  return res.status(outcome.value.status).json(outcome.value.body);
});

/**
 * DELETE /api/users/:id
 * Admin-only account deletion. Self-deletion and deletion of the last admin
 * are blocked. Related tuitions, their applications and saved-tuition
 * references are cleaned up; payment history is intentionally preserved.
 */
router.delete('/:id', verifyToken, verifyAdmin, async (req, res) => {
  const targetId = toObjectId(req.params.id);
  const adminId = toObjectId(req.user.id);

  if (!targetId || !adminId) {
    return res.status(404).json({
      success: false,
      message: 'User not found',
    });
  }

  await ensureAdminLockIndex();

  const outcome = await withAdminLock(usersCollection(), adminId, async () => {
    const users = usersCollection();
    const target = await users.findOne(
      { _id: targetId },
      { projection: { role: 1 } }
    );

    if (!target) {
      return {
        status: 404,
        body: { success: false, message: 'User not found' },
      };
    }

    const adminCount = await users.countDocuments({ role: 'admin' });
    const conflict = describeUserDeleteConflict(
      adminId,
      targetId,
      target.role,
      adminCount
    );

    if (conflict) {
      return { status: conflict.status, body: conflict };
    }

    const ownedTuitions = await tuitionsCollection()
      .find({ tutorId: targetId }, { projection: { _id: 1 } })
      .toArray();
    const tuitionIds = ownedTuitions.map((tuition) => tuition._id);
    const tuitionIdStrings = new Set(tuitionIds.map((id) => id.toString()));

    const applicationsFilter = {
      $or: [{ studentId: targetId }],
    };

    if (tuitionIds.length > 0) {
      applicationsFilter.$or.push({ tuitionId: { $in: tuitionIds } });
    }

    const applicationsResult = await applicationsCollection().deleteMany(
      applicationsFilter
    );

    let tuitionsResult = { deletedCount: 0 };

    if (tuitionIds.length > 0) {
      tuitionsResult = await tuitionsCollection().deleteMany({
        _id: { $in: tuitionIds },
      });

      // Remove dangling bookmark references from every remaining user,
      // including legacy string-form ids.
      const bookmarkValues = [...tuitionIds, ...tuitionIdStrings];

      await users.updateMany(
        { savedTuitionIds: { $in: bookmarkValues } },
        { $pull: { savedTuitionIds: { $in: bookmarkValues } } }
      );
    }

    // Compare-and-set on the role: if the account was promoted or otherwise
    // changed outside this serialized section, do not delete it blindly.
    const deleteFilter = { _id: targetId };

    if (target.role !== undefined) {
      deleteFilter.role = target.role;
    }

    const deletedUser = await users.deleteOne(deleteFilter);

    if (deletedUser.deletedCount === 0) {
      return {
        status: 409,
        body: {
          success: false,
          message: 'User role changed. Please try again.',
        },
      };
    }

    // Payments are intentionally left untouched: transaction history must
    // survive account deletion.

    return {
      status: 200,
      body: {
        success: true,
        message: 'User deleted successfully',
        data: {
          id: targetId.toString(),
          deletedTuitions: tuitionsResult.deletedCount,
          deletedApplications: applicationsResult.deletedCount,
          removedBookmarkReferences: tuitionIdStrings.size,
        },
      },
    };
  });

  if (!outcome.acquired) {
    return adminLockContentionResponse(res);
  }

  return res.status(outcome.value.status).json(outcome.value.body);
});

export default router;
