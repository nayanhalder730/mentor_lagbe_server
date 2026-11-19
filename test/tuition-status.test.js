import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getApprovalUpdate,
  getNewTuitionState,
  getPublicTuitionFilter,
} from '../src/utils/tuition-status.js';

/**
 * Mirrors the MongoDB equality filter used by GET /api/tuitions for the two
 * visibility fields. Optional query filters are irrelevant here.
 */
function matchesPublicFilter(tuition, filter) {
  return Object.entries(filter).every(
    ([field, value]) => tuition[field] === value
  );
}

test('a newly created tuition is pending and active', () => {
  assert.deepEqual(getNewTuitionState(), {
    approvalStatus: 'pending',
    isActive: true,
  });
});

test('pending tuition is not publicly visible', () => {
  const tuition = {
    ...getNewTuitionState(),
    title: 'Pending tuition',
  };

  assert.equal(matchesPublicFilter(tuition, getPublicTuitionFilter()), false);
});

test('approved and active tuition is publicly visible', () => {
  const tuition = { approvalStatus: 'approved', isActive: true };

  assert.equal(matchesPublicFilter(tuition, getPublicTuitionFilter()), true);
});

test('rejected tuition is not publicly visible', () => {
  const tuition = { approvalStatus: 'rejected', isActive: true };

  assert.equal(matchesPublicFilter(tuition, getPublicTuitionFilter()), false);
});

test('approved but inactive tuition is not publicly visible', () => {
  const tuition = { approvalStatus: 'approved', isActive: false };

  assert.equal(matchesPublicFilter(tuition, getPublicTuitionFilter()), false);
});

test('the public filter returns a fresh object for each request', () => {
  const first = getPublicTuitionFilter();
  const second = getPublicTuitionFilter();

  first.mode = 'Online';

  assert.notEqual(first, second);
  assert.equal('mode' in second, false);
  assert.deepEqual(second, { approvalStatus: 'approved', isActive: true });
});

test('approval activates approved tuitions and deactivates rejected ones', () => {
  assert.deepEqual(getApprovalUpdate('approved'), {
    approvalStatus: 'approved',
    isActive: true,
  });

  assert.deepEqual(getApprovalUpdate('rejected'), {
    approvalStatus: 'rejected',
    isActive: false,
  });
});

test('approval rejects unsupported status values', () => {
  assert.throws(() => getApprovalUpdate('pending'), TypeError);
});
