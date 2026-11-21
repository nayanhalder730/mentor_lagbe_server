import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import userRouter from '../src/routes/user.routes.js';
import {
  verifyAdmin,
  verifyToken,
} from '../src/middleware/auth.middleware.js';
import {
  ASSIGNABLE_ROLES,
  SAFE_USER_PROJECTION,
  SELF_UPDATABLE_FIELDS,
  buildRoleChangeUpdate,
  describeRoleChangeConflict,
  isAdminDemotion,
  isSelfRoleChange,
  toSafeProfile,
  validateRoleChangeBody,
} from '../src/utils/user-management.js';

function handlersFor(method, path) {
  const layer = userRouter.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );

  assert.ok(layer, `${method.toUpperCase()} ${path} must be registered`);

  return layer.route.stack.map((entry) => entry.handle);
}

test('user listing and role change require admin authorization', () => {
  for (const [method, path] of [
    ['get', '/'],
    ['patch', '/:id/role'],
  ]) {
    const handlers = handlersFor(method, path);

    assert.ok(handlers.includes(verifyToken), `${path} requires authentication`);
    assert.ok(handlers.includes(verifyAdmin), `${path} requires the admin role`);
  }
});

test('public self-update route cannot change role or other protected fields', () => {
  const handlers = handlersFor('patch', '/me');

  assert.ok(handlers.includes(verifyToken));
  assert.equal(handlers.includes(verifyAdmin), false);

  for (const field of [
    'role',
    'plan',
    'email',
    'password',
    'approvalStatus',
    'isActive',
  ]) {
    assert.equal(SELF_UPDATABLE_FIELDS.has(field), false);
  }
});

test('role change accepts student, tutor and admin', () => {
  assert.deepEqual(validateRoleChangeBody({ role: 'student' }), {
    value: 'student',
  });
  assert.deepEqual(validateRoleChangeBody({ role: 'tutor' }), {
    value: 'tutor',
  });
  assert.deepEqual(validateRoleChangeBody({ role: 'admin' }), {
    value: 'admin',
  });

  for (const body of [
    null,
    undefined,
    [],
    {},
    { role: 'ADMIN' },
    { role: 1 },
    { role: 'student', plan: 'pro' },
    { role: 'student', userId: new ObjectId().toHexString() },
  ]) {
    assert.ok(validateRoleChangeBody(body).error);
  }

  assert.deepEqual(validateRoleChangeBody({ role: 'owner' }), {
    error: 'role must be one of: student, tutor, admin',
  });
  assert.equal(ASSIGNABLE_ROLES.has('admin'), true);
});

test('self-demotion is prevented with ObjectId-safe comparison', () => {
  const adminId = new ObjectId();

  assert.equal(isSelfRoleChange(adminId, adminId), true);
  assert.equal(
    isSelfRoleChange(adminId, new ObjectId(adminId.toHexString())),
    true
  );
  assert.equal(isSelfRoleChange(adminId, new ObjectId()), false);
  assert.equal(isSelfRoleChange(null, adminId), false);
});

test('admin demotion can be detected for last-admin protection', () => {
  assert.equal(isAdminDemotion('admin', 'student'), true);
  assert.equal(isAdminDemotion('admin', 'tutor'), true);
  assert.equal(isAdminDemotion('admin', 'admin'), false);
  assert.equal(isAdminDemotion('student', 'admin'), false);
  assert.equal(isAdminDemotion('tutor', 'student'), false);
});

test('safe projection and profile never expose authentication fields', () => {
  const projectionKeys = Object.keys(SAFE_USER_PROJECTION);

  for (const field of [
    'name',
    'email',
    'image',
    'role',
    'phone',
    'bio',
    'plan',
    'createdAt',
  ]) {
    assert.ok(projectionKeys.includes(field));
  }

  for (const field of [
    'password',
    'passwordHash',
    'hash',
    'salt',
    'tokens',
    'sessions',
    'accounts',
    'emailVerified',
  ]) {
    assert.equal(projectionKeys.includes(field), false);
  }

  const userId = new ObjectId();
  const profile = toSafeProfile({
    _id: userId,
    name: 'Test User',
    email: 'user@example.com',
    role: 'tutor',
    plan: 'pro',
    image: null,
    createdAt: new Date(),
  });

  assert.deepEqual(Object.keys(profile).sort(), [
    'bio',
    'createdAt',
    'email',
    'id',
    'image',
    'name',
    'phone',
    'plan',
    'role',
  ]);
  assert.equal(profile.id, userId.toString());

  const fallback = toSafeProfile({
    _id: userId,
    name: 'Other User',
    email: 'other@example.com',
    role: 'superuser',
    plan: 'gold',
  });

  assert.equal(fallback.role, 'student');
  assert.equal(fallback.plan, 'free');
});

test('role update query is atomic and uses compare-and-set', () => {
  const targetId = new ObjectId();
  const { filter, update } = buildRoleChangeUpdate(
    targetId,
    'tutor',
    'student'
  );

  assert.deepEqual(Object.keys(filter).sort(), ['_id', 'role']);
  assert.equal(String(filter._id), String(targetId));
  assert.equal(filter.role, 'student');

  const withoutExpected = buildRoleChangeUpdate(targetId, 'admin');

  assert.deepEqual(Object.keys(withoutExpected.filter), ['_id']);

  assert.deepEqual(Object.keys(update.$set).sort(), ['role', 'updatedAt']);
  assert.equal(update.$set.role, 'tutor');
  assert.ok(update.$set.updatedAt instanceof Date);
  assert.equal('plan' in update.$set, false);
  assert.equal('email' in update.$set, false);
});

test('role change conflicts are safe and do not reveal other users', () => {
  assert.deepEqual(describeRoleChangeConflict(null), {
    status: 404,
    success: false,
    message: 'User not found',
  });

  const unchanged = describeRoleChangeConflict({ role: 'admin' });

  assert.equal(unchanged.status, 409);
  assert.equal(unchanged.success, false);
  assert.match(unchanged.message, /could not be updated/);

  const genericConflict = describeRoleChangeConflict({ role: 'student' });

  assert.equal(genericConflict.status, 409);
  assert.equal(genericConflict.success, false);
});
