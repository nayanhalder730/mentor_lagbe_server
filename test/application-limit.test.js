import test from 'node:test';
import assert from 'node:assert/strict';

import applicationRouter from '../src/routes/application.routes.js';
import {
  verifyStudent,
  verifyToken,
  verifyTutor,
} from '../src/middleware/auth.middleware.js';
import {
  APPLICATION_LIMIT_CODE,
  FREE_STUDENT_APPLICATION_LIMIT,
  buildApplicationLimitResponse,
  buildApplicationSlotIndexSpec,
  chooseApplicationSlot,
  isProPlan,
} from '../src/utils/application-limit.js';

function createHandler() {
  const layer = applicationRouter.stack.find(
    (entry) => entry.route?.path === '/' && entry.route.methods.post
  );

  assert.ok(layer, 'POST /api/applications must be registered');

  return layer.route.stack.map((entry) => entry.handle);
}

test('free student application limit is two', () => {
  assert.equal(FREE_STUDENT_APPLICATION_LIMIT, 2);
  assert.equal(isProPlan('pro'), true);
  assert.equal(isProPlan('free'), false);
  assert.equal(isProPlan(undefined), false);
});

test('application limit response is clear and upgrade-oriented', () => {
  const response = buildApplicationLimitResponse();

  assert.equal(response.status, 403);
  assert.equal(response.success, false);
  assert.equal(response.code, APPLICATION_LIMIT_CODE);
  assert.match(response.message, /at most 2 applications/i);
  assert.match(response.message, /Upgrade to Student Pro/i);
});

test('slot index is unique, sparse and uses only the applications collection', () => {
  const spec = buildApplicationSlotIndexSpec();

  assert.deepEqual(spec.keys, { studentId: 1, applicationSlot: 1 });
  assert.equal(spec.options.unique, true);
  assert.equal(spec.options.sparse, true);
  assert.equal(spec.options.name, 'uniq_student_application_slot');
});

test('slot selection fills only free slots one and two', () => {
  assert.equal(chooseApplicationSlot([], 0), 1);
  assert.equal(chooseApplicationSlot([1], 1), 2);
  assert.equal(chooseApplicationSlot([2], 1), 1);
  assert.equal(chooseApplicationSlot([1, 2], 2), 3);
});

test('application creation requires a verified student', () => {
  const handlers = createHandler();

  assert.ok(handlers.includes(verifyToken));
  assert.ok(handlers.includes(verifyStudent));
  assert.equal(handlers.includes(verifyTutor), false);
});
