import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import userRouter from '../src/routes/user.routes.js';
import {
  verifyAdmin,
  verifyStudent,
  verifyToken,
} from '../src/middleware/auth.middleware.js';
import { SAFE_USER_PROJECTION } from '../src/utils/user-management.js';
import {
  buildRemoveTuitionUpdate,
  buildSaveTuitionUpdate,
  buildSavedTuitionsFilter,
  getSavedTuitionIds,
  parseTuitionId,
} from '../src/utils/saved-tuitions.js';

const userId = new ObjectId();
const tuitionId = new ObjectId();

function handlersFor(method, path) {
  const layer = userRouter.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );

  assert.ok(layer, `${method.toUpperCase()} ${path} must be registered`);

  return layer.route.stack.map((entry) => entry.handle);
}

test('saved tuition routes require token and student role', () => {
  for (const [method, path] of [
    ['get', '/me/saved-tuitions'],
    ['post', '/me/saved-tuitions/:tuitionId'],
    ['delete', '/me/saved-tuitions/:tuitionId'],
  ]) {
    const handlers = handlersFor(method, path);

    assert.ok(handlers.includes(verifyToken), `${path} requires authentication`);
    assert.ok(handlers.includes(verifyStudent), `${path} requires the student role`);
    assert.equal(handlers.includes(verifyAdmin), false);
  }
});

test('tuition ids are parsed safely', () => {
  assert.equal(parseTuitionId('not-an-id'), null);
  assert.equal(parseTuitionId(''), null);
  assert.equal(parseTuitionId(undefined), null);

  const valid = new ObjectId().toHexString();

  assert.equal(parseTuitionId(valid)?.toString(), valid);
});

test('save is atomic, duplicate-safe, and scoped to the authenticated user', () => {
  const { filter, update } = buildSaveTuitionUpdate(userId, tuitionId);

  assert.equal(String(filter._id), String(userId));
  assert.deepEqual(filter.savedTuitionIds, { $ne: tuitionId });
  assert.deepEqual(update, { $addToSet: { savedTuitionIds: tuitionId } });
});

test('remove only pulls from the authenticated user document', () => {
  const { filter, update } = buildRemoveTuitionUpdate(userId, tuitionId);

  assert.deepEqual(Object.keys(filter), ['_id']);
  assert.equal(String(filter._id), String(userId));
  assert.deepEqual(update, { $pull: { savedTuitionIds: tuitionId } });
});

test('saved list query never returns unpublished or inactive tuitions', () => {
  const filter = buildSavedTuitionsFilter([tuitionId]);

  assert.deepEqual(filter._id, { $in: [tuitionId] });
  assert.equal(filter.approvalStatus, 'approved');
  assert.equal(filter.isActive, true);
  assert.equal('tutorId' in filter, false);
  assert.equal('userId' in filter, false);
});

test('stored saved ids are normalized without trusting malformed values', () => {
  const validId = new ObjectId();

  const ids = getSavedTuitionIds({
    _id: userId,
    savedTuitionIds: [validId, validId.toHexString(), 'bad-id', null, undefined],
  });

  assert.deepEqual(ids, [validId.toString(), validId.toString()]);
  assert.deepEqual(getSavedTuitionIds(null), []);
  assert.deepEqual(getSavedTuitionIds({ _id: userId }), []);
});

test('safe user projection excludes authentication fields', () => {
  const keys = Object.keys(SAFE_USER_PROJECTION);

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
    assert.equal(keys.includes(field), false);
  }

  assert.equal(keys.includes('savedTuitionIds'), false);
});
