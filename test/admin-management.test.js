import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import userRoutes from '../src/routes/user.routes.js';
import tuitionRoutes, {
  adminTuitionRouter,
} from '../src/routes/tuition.routes.js';
import applicationRoutes, {
  adminApplicationRouter,
} from '../src/routes/application.routes.js';
import {
  verifyToken,
  verifyAdmin,
  verifyStudent,
} from '../src/middleware/auth.middleware.js';
import { describeUserDeleteConflict } from '../src/utils/user-management.js';
import {
  FREE_STUDENT_SAVE_LIMIT,
  buildSaveTuitionUpdate,
  buildSavedTuitionLimitResponse,
} from '../src/utils/saved-tuitions.js';

function handlers(router, path, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must be registered`);
  return layer.route.stack.map((entry) => entry.handle);
}

test('admin user deletion is registered with admin authorization', () => {
  const chain = handlers(userRoutes, '/:id', 'delete');
  assert.ok(chain.includes(verifyToken));
  assert.ok(chain.includes(verifyAdmin));
});

test('deleting the last admin or your own account is blocked', () => {
  const adminId = new ObjectId();
  const otherId = new ObjectId();

  assert.match(
    describeUserDeleteConflict(adminId, adminId, 'student', 3).message,
    /own account/i
  );
  assert.match(
    describeUserDeleteConflict(adminId, otherId, 'admin', 1).message,
    /last admin/i
  );
  assert.equal(
    describeUserDeleteConflict(adminId, otherId, 'tutor', 3),
    null
  );
});

test('admin tuition deletion and application listing require admin role', () => {
  const deleteChain = handlers(adminTuitionRouter, '/:id', 'delete');
  assert.ok(deleteChain.includes(verifyToken));
  assert.ok(deleteChain.includes(verifyAdmin));

  const listChain = handlers(adminApplicationRouter, '/', 'get');
  assert.ok(listChain.includes(verifyToken));
  assert.ok(listChain.includes(verifyAdmin));
});

test('student application routes remain student-scoped', () => {
  const createChain = handlers(applicationRoutes, '/', 'post');
  assert.ok(createChain.includes(verifyToken));
  assert.ok(createChain.includes(verifyStudent));
  assert.equal(createChain.includes(verifyAdmin), false);
});

test('free bookmark cap is five and enforced atomically', () => {
  assert.equal(FREE_STUDENT_SAVE_LIMIT, 5);

  const userId = new ObjectId();
  const tuitionId = new ObjectId();
  const free = buildSaveTuitionUpdate(userId, tuitionId, 5);
  const pro = buildSaveTuitionUpdate(userId, tuitionId, null);

  assert.deepEqual(free.filter.$expr, {
    $lt: [{ $size: { $ifNull: ['$savedTuitionIds', []] } }, 5],
  });
  assert.equal(pro.filter.$expr, undefined);
  assert.deepEqual(free.update, { $addToSet: { savedTuitionIds: tuitionId } });

  const limit = buildSavedTuitionLimitResponse();
  assert.equal(limit.status, 403);
  assert.equal(limit.code, 'FREE_BOOKMARK_LIMIT');
  assert.match(limit.message, /at most 5/i);
});
