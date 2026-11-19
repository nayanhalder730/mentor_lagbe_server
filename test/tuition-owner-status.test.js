import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import tuitionRouter from '../src/routes/tuition.routes.js';
import {
  verifyAdmin,
  verifyToken,
  verifyTutor,
} from '../src/middleware/auth.middleware.js';
import {
  buildOwnedTuitionFilter,
  buildTutorStatusUpdate,
  describeTutorStatusConflict,
  getTutorStatusMessage,
  validateTutorStatusBody,
} from '../src/utils/tuition-status.js';

const tuitionId = new ObjectId();
const tutorId = new ObjectId();

test('tutor status payload accepts only a boolean isActive', () => {
  assert.deepEqual(validateTutorStatusBody({ isActive: true }), { value: true });
  assert.deepEqual(validateTutorStatusBody({ isActive: false }), { value: false });
});

test('tutor status payload rejects invalid and protected fields', () => {
  for (const body of [
    null,
    undefined,
    [],
    {},
    { isActive: 'true' },
    { isActive: 1 },
    { approvalStatus: 'approved' },
    { isActive: true, approvalStatus: 'approved' },
    { isActive: true, tutorId: tutorId.toHexString() },
    { isActive: true, plan: 'pro' },
  ]) {
    assert.ok(validateTutorStatusBody(body).error);
  }

  assert.deepEqual(validateTutorStatusBody({}), {
    error: 'Only isActive can be updated',
  });
  assert.deepEqual(validateTutorStatusBody({ isActive: 'yes' }), {
    error: 'isActive must be a boolean',
  });
  assert.deepEqual(validateTutorStatusBody(null), {
    error: 'Request body must be a JSON object',
  });
});

test('atomic update filter requires ownership and approved status', () => {
  const { filter } = buildTutorStatusUpdate(tuitionId, tutorId, true);

  assert.deepEqual(Object.keys(filter).sort(), [
    '_id',
    'approvalStatus',
    'tutorId',
  ]);
  assert.equal(String(filter._id), String(tuitionId));
  assert.equal(String(filter.tutorId), String(tutorId));
  assert.equal(filter.approvalStatus, 'approved');
});

test('update query only sets isActive', () => {
  for (const isActive of [true, false]) {
    const { update } = buildTutorStatusUpdate(tuitionId, tutorId, isActive);

    assert.deepEqual(update, { $set: { isActive } });
    assert.equal('approvalStatus' in update.$set, false);
    assert.equal('tutorId' in update.$set, false);
    assert.equal('plan' in update.$set, false);
  }
});

test('failed-update lookup is scoped to the owning tutor only', () => {
  const filter = buildOwnedTuitionFilter(tuitionId, tutorId);

  assert.deepEqual(Object.keys(filter).sort(), ['_id', 'tutorId']);
  assert.equal(String(filter._id), String(tuitionId));
  assert.equal(String(filter.tutorId), String(tutorId));
});

test('pending and rejected tuitions produce a conflict', () => {
  for (const approvalStatus of ['pending', 'rejected']) {
    const conflict = describeTutorStatusConflict({ approvalStatus });

    assert.equal(conflict.status, 409);
    assert.equal(conflict.success, false);
    assert.match(conflict.message, new RegExp(approvalStatus));
  }
});

test('missing or foreign tuition produces a generic 404', () => {
  assert.deepEqual(describeTutorStatusConflict(null), {
    status: 404,
    success: false,
    message: 'Tuition not found',
  });
});

test('success messages reflect the new active state', () => {
  assert.equal(getTutorStatusMessage(true), 'Tuition activated');
  assert.equal(getTutorStatusMessage(false), 'Tuition deactivated');
});

test('tutor status route is protected by token and tutor middleware', () => {
  const layer = tuitionRouter.stack.find(
    (entry) =>
      entry.route?.path === '/:id/status' && entry.route.methods.patch
  );

  assert.ok(layer, 'PATCH /:id/status must be registered on the tutor router');

  const handlers = layer.route.stack.map((entry) => entry.handle);

  assert.ok(handlers.includes(verifyToken), 'requires authentication');
  assert.ok(handlers.includes(verifyTutor), 'requires the tutor role');
  assert.equal(handlers.includes(verifyAdmin), false);
});
