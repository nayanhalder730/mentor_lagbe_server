import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';
import { verifyToken, verifyAdmin } from '../middleware/auth.middleware.js';

const router = Router();

// Better Auth's MongoDB adapter stores users in the singular `user` model
// collection and maps its `id` field to MongoDB's `_id`.
const USERS_COLLECTION = 'user';

const ALLOWED_ROLES = new Set(['student', 'tutor', 'admin']);
const ALLOWED_PLANS = new Set(['free', 'pro']);
const UPDATABLE_FIELDS = new Set(['name', 'image', 'phone', 'bio']);

const PROFILE_PROJECTION = {
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  phone: 1,
  bio: 1,
  plan: 1,
  createdAt: 1,
};

function usersCollection() {
  return getDb().collection(USERS_COLLECTION);
}

/**
 * Converts a Better Auth user document into the safe profile shape required
 * by the assignment. Internal auth fields are never included.
 */
function toSafeProfile(document) {
  return {
    id: document._id.toString(),
    name: document.name,
    email: document.email,
    image: document.image || null,
    role: ALLOWED_ROLES.has(document.role) ? document.role : 'student',
    phone: document.phone || null,
    bio: document.bio || null,
    plan: ALLOWED_PLANS.has(document.plan) ? document.plan : 'free',
    createdAt: document.createdAt ?? null,
  };
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
    { projection: PROFILE_PROJECTION }
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
  const unsupportedFields = bodyFields.filter((field) => !UPDATABLE_FIELDS.has(field));

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
      projection: PROFILE_PROJECTION,
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
    if (typeof req.query.role !== 'string' || !ALLOWED_ROLES.has(req.query.role)) {
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
    .find(filter, { projection: PROFILE_PROJECTION })
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

export default router;
