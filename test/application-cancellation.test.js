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
  buildCancelApplicationFilter,
  buildOwnedApplicationFilter,
  getCancellationOutcome,
  parseApplicationId,
} from '../src/utils/application-cancellation.js';

const studentId = new ObjectId();
const otherStudentId = new ObjectId();

/** Mirrors MongoDB equality matching for the filters used by the route. */
function matches(filter, document) {
  if (!document) return false;

  return Object.entries(filter).every(([field, value]) => {
    if (field === '_id' || field === 'studentId') {
      return String(document[field]) === String(value);
    }

    return document[field] === value;
  });
}

test('student successfully cancels their own pending application', () => {
  const applicationId = new ObjectId();
  const application = { _id: applicationId, studentId, status: 'pending' };
  const filter = buildCancelApplicationFilter(applicationId, studentId);

  assert.equal(matches(filter, application), true);
  assert.deepEqual(getCancellationOutcome(1, null), {
    status: 200,
    success: true,
    message: 'Application cancelled successfully',
  });
});

test('the delete filter atomically requires ownership and pending status', () => {
  const applicationId = new ObjectId();
  const filter = buildCancelApplicationFilter(applicationId, studentId);

  assert.deepEqual(Object.keys(filter).sort(), [
    '_id',
    'status',
    'studentId',
  ]);
  assert.equal(String(filter._id), String(applicationId));
  assert.equal(String(filter.studentId), String(studentId));
  assert.equal(filter.status, 'pending');
});

test('student cannot cancel another student\'s application', () => {
  const applicationId = new ObjectId();
  const foreignApplication = {
    _id: applicationId,
    studentId: otherStudentId,
    status: 'pending',
  };

  assert.equal(
    matches(buildCancelApplicationFilter(applicationId, studentId), foreignApplication),
    false
  );
  assert.equal(
    matches(buildOwnedApplicationFilter(applicationId, studentId), foreignApplication),
    false
  );
  assert.equal(getCancellationOutcome(0, null).status, 404);
});

test('student cannot cancel an accepted application', () => {
  const applicationId = new ObjectId();
  const accepted = { _id: applicationId, studentId, status: 'accepted' };

  assert.equal(
    matches(buildCancelApplicationFilter(applicationId, studentId), accepted),
    false
  );

  const outcome = getCancellationOutcome(0, accepted);

  assert.equal(outcome.status, 409);
  assert.equal(outcome.success, false);
  assert.match(outcome.message, /already accepted/);
});

test('student cannot cancel a rejected application', () => {
  const applicationId = new ObjectId();
  const rejected = { _id: applicationId, studentId, status: 'rejected' };

  assert.equal(
    matches(buildCancelApplicationFilter(applicationId, studentId), rejected),
    false
  );

  const outcome = getCancellationOutcome(0, rejected);

  assert.equal(outcome.status, 409);
  assert.equal(outcome.success, false);
  assert.match(outcome.message, /already rejected/);
});

test('invalid application ids are handled safely', () => {
  assert.equal(parseApplicationId('not-an-object-id'), null);
  assert.equal(parseApplicationId(''), null);
  assert.equal(parseApplicationId(undefined), null);
  assert.equal(parseApplicationId(null), null);

  const validId = new ObjectId().toHexString();

  assert.equal(parseApplicationId(validId)?.toString(), validId);
});

test('nonexistent application returns a generic 404', () => {
  const outcome = getCancellationOutcome(0, null);

  assert.deepEqual(outcome, {
    status: 404,
    success: false,
    message: 'Application not found',
  });
});

test('tutor and admin cannot use the student cancellation endpoint', () => {
  const deleteLayer = applicationRouter.stack.find(
    (layer) => layer.route?.path === '/:id' && layer.route.methods.delete
  );

  assert.ok(deleteLayer, 'DELETE /:id must be registered');

  const handlers = deleteLayer.route.stack.map((entry) => entry.handle);

  assert.ok(handlers.includes(verifyToken), 'requires authentication');
  assert.ok(handlers.includes(verifyStudent), 'requires the student role');
  assert.equal(handlers.includes(verifyTutor), false);
  assert.equal(handlers.includes(verifyAdmin), false);
});
