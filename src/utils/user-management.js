import { ObjectId } from 'mongodb';

/**
 * Admin user-management rules.
 *
 * The `user` collection is Better Auth's own collection; these helpers only
 * add safe admin operations around it. No duplicate collection, auth field,
 * or private credential is ever written or returned.
 */

export const USER_ROLES = new Set(['student', 'tutor', 'admin']);
export const USER_PLANS = new Set(['free', 'pro']);

/** Roles an admin may assign through the role-change endpoint. */
export const ASSIGNABLE_ROLES = new Set(USER_ROLES);

/** Fields a user may change on their own profile. `role` is never included. */
export const SELF_UPDATABLE_FIELDS = new Set([
  'name',
  'image',
  'phone',
  'bio',
]);

/**
 * Explicit allowlist for user documents returned to clients. Better Auth's
 * password hashes, tokens, sessions, and other private fields are absent.
 */
export const SAFE_USER_PROJECTION = Object.freeze({
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  phone: 1,
  bio: 1,
  plan: 1,
  createdAt: 1,
});

/** Safe, assignment-accurate profile shape. */
export function toSafeProfile(document) {
  return {
    id: document._id.toString(),
    name: document.name,
    email: document.email,
    image: document.image || null,
    role: USER_ROLES.has(document.role) ? document.role : 'student',
    phone: document.phone || null,
    bio: document.bio || null,
    plan: USER_PLANS.has(document.plan) ? document.plan : 'free',
    createdAt: document.createdAt ?? null,
  };
}

/** Only `{ role: 'student' | 'tutor' | 'admin' }` is accepted. */
export function validateRoleChangeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  if (Object.keys(body).length !== 1 || !('role' in body)) {
    return { error: 'Only role can be updated' };
  }

  if (typeof body.role !== 'string' || !ASSIGNABLE_ROLES.has(body.role)) {
    return { error: 'role must be one of: student, tutor, admin' };
  }

  return { value: body.role };
}

/** ObjectId-safe self check, independent of id string casing. */
export function isSelfRoleChange(adminId, targetId) {
  if (!adminId || !targetId) {
    return false;
  }

  return adminId.toString() === targetId.toString();
}

/**
 * Atomic role update. The optional expected role makes the update a
 * compare-and-set so a concurrent role change cannot be overwritten.
 */
export function buildRoleChangeUpdate(targetId, role, expectedRole) {
  return {
    filter: {
      _id: targetId,
      ...(expectedRole ? { role: expectedRole } : {}),
    },
    update: {
      $set: {
        role,
        updatedAt: new Date(),
      },
    },
  };
}

/** True when a role change would remove admin privileges from an account. */
export function isAdminDemotion(currentRole, nextRole) {
  return currentRole === 'admin' && nextRole !== 'admin';
}

/** Response when the atomic update did not match a document. */
export function describeRoleChangeConflict(current) {
  if (!current) {
    return {
      status: 404,
      success: false,
      message: 'User not found',
    };
  }

  if (!ASSIGNABLE_ROLES.has(current.role)) {
    return {
      status: 409,
      success: false,
      message: 'Admin accounts cannot be changed through this endpoint',
    };
  }

  return {
    status: 409,
    success: false,
    message: 'User role could not be updated. Please try again.',
  };
}
