import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import applicationRouter from '../src/routes/application.routes.js';
import {
  verifyAdmin,
  verifyStudent,
  verifyToken,
  verifyTutor,
} from '../src/middleware/auth.middleware.js';
import {
  buildApplicationCheckFilter,
  buildApplicationCheckResponse,
  parseCheckTuitionId,
} from '../src/utils/application-check.js';

const studentId = new ObjectId();
const tuitionId = new ObjectId();

function checkHandlers() {
  const layer = applicationRouter.stack.find(
    (entry) => entry.route?.path === '/check' && entry.route.methods.get
  );

  assert.ok(layer, 'GET /check must be registered');

  return layer.route.stack.map((entry) => entry.handle);
}

test('application check requires a verified student', () => {
  const handlers = checkHandlers();

  assert.ok(handlers.includes(verifyToken), 'requires a verified JWT');
  assert.ok(handlers.includes(verifyStudent), 'requires the student role');
  assert.equal(handlers.includes(verifyTutor), false);
  assert.equal(handlers.includes(verifyAdmin), false);
});

test('valid tuition ids are parsed and invalid values rejected', () => {
  assert.equal(
    parseCheckTuitionId(tuitionId.toHexString())?.toString(),
    tuitionId.toString()
  );

  for (const value of [undefined, null, '', 'not-an-id', 'https://evil.com', 123]) {
    assert.equal(parseCheckTuitionId(value), null);
  }
});

test('check filter is scoped to the authenticated student', () => {
  const filter = buildApplicationCheckFilter(studentId, tuitionId);

  assert.deepEqual(Object.keys(filter).sort(), ['studentId', 'tuitionId']);
  assert.equal(String(filter.studentId), String(studentId));
  assert.equal(String(filter.tuitionId), String(tuitionId));
  assert.equal('email' in filter, false);
  assert.equal('userRole' in filter, false);
});

test('a different student id can never match the same application', () => {
  const filter = buildApplicationCheckFilter(new ObjectId(), tuitionId);

  assert.notEqual(String(filter.studentId), String(studentId));
});

test('check response exposes only existence and the safe review status', () => {
  assert.deepEqual(buildApplicationCheckResponse(null), {
    hasApplied: false,
    status: null,
  });

  for (const status of ['pending', 'accepted', 'rejected']) {
    assert.deepEqual(
      buildApplicationCheckResponse({
        status,
        studentId,
        tuitionId,
        studentEmail: 'private@example.test',
      }),
      { hasApplied: true, status }
    );
  }
});
