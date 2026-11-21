import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import {
  getPublicTuitionFilter,
  normalizeFilterOptions,
} from '../src/utils/tuition-status.js';
import {
  TUITION_PROJECTION,
  toTuitionResponse,
} from '../src/routes/tuition.routes.js';
import { buildDuplicateApplicationResponse } from '../src/routes/application.routes.js';
import {
  getDowngradeUserFilter,
  subscriptionMatchesIdentity,
} from '../src/routes/payment.routes.js';

test('public tuition filter requires both approval and active status', () => {
  assert.deepEqual(getPublicTuitionFilter(), {
    approvalStatus: 'approved',
    isActive: true,
  });
});

test('tuition projection never exposes the internal tutorId', () => {
  assert.equal(TUITION_PROJECTION.tutorId, undefined);

  const response = toTuitionResponse({
    _id: new ObjectId(),
    title: 'Math',
    subject: 'Mathematics',
    classLevel: 'HSC',
    mode: 'Online',
    location: 'Dhaka',
    monthlyFee: 2000,
    daysPerWeek: 2,
    description: 'desc',
    tutorName: 'Tutor',
    tutorEmail: 'tutor@example.test',
    tutorId: new ObjectId(),
    approvalStatus: 'approved',
    isActive: true,
  });

  assert.equal('tutorId' in response, false);
});

test('filter options are trimmed, deduplicated and sorted', () => {
  assert.deepEqual(
    normalizeFilterOptions([' Physics ', 'math', 'Mathematics', '', null, 'Physics']),
    ['math', 'Mathematics', 'Physics']
  );
  assert.deepEqual(normalizeFilterOptions('not an array'), []);
});

test('duplicate application response is a clear 409', () => {
  const response = buildDuplicateApplicationResponse();

  assert.equal(response.status, 409);
  assert.equal(response.success, false);
  assert.match(response.message, /already applied/i);
});

test('subscription identity requires a matching metadata user id', () => {
  const userId = new ObjectId();

  assert.equal(
    subscriptionMatchesIdentity(
      { metadata: { userId: userId.toHexString() } },
      userId
    ),
    true
  );
  assert.equal(
    subscriptionMatchesIdentity({ metadata: { userId: new ObjectId().toHexString() } }, userId),
    false
  );
  assert.equal(subscriptionMatchesIdentity({ metadata: {} }, userId), false);
  assert.equal(subscriptionMatchesIdentity({}, userId), false);
  assert.equal(subscriptionMatchesIdentity({ metadata: { userId: 'x' } }, null), false);
});

test('downgrade filter targets only student/tutor accounts by id', () => {
  const userId = new ObjectId();
  const filter = getDowngradeUserFilter(userId);

  assert.deepEqual(filter._id, userId);
  assert.deepEqual(filter.role, { $in: ['student', 'tutor'] });
});
