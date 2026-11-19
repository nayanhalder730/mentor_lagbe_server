import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import {
  buildStudentApplicationsFilter,
  buildTutorIdQuery,
  collectTutorIds,
  indexTutorNames,
  toStudentApplicationList,
} from '../src/utils/application-tutor.js';

const studentId = new ObjectId();
const tutorId = new ObjectId();

/** Mirrors the existing mapper fields relevant to these tests. */
function toBaseResponse(application) {
  return {
    id: application._id.toString(),
    tuitionTitle: application.tuitionTitle,
    tutorEmail: application.tutorEmail,
    monthlyFee: application.monthlyFee,
    appliedAt: application.appliedAt,
    status: application.status,
  };
}

function makeApplication(overrides = {}) {
  return {
    _id: new ObjectId(),
    tuitionTitle: 'HSC Mathematics',
    tutorId,
    tutorEmail: 'tutor@example.com',
    monthlyFee: 3000,
    appliedAt: '2026-11-01T09:00:00.000Z',
    status: 'pending',
    ...overrides,
  };
}

test('tutor name is included from the real user record', () => {
  const application = makeApplication();
  const tutors = [
    {
      _id: tutorId,
      name: 'Jane Doe',
      email: 'unrelated@example.com',
      plan: 'pro',
      role: 'tutor',
    },
  ];

  const [result] = toStudentApplicationList([application], tutors, toBaseResponse);

  assert.equal(result.tutorName, 'Jane Doe');
  assert.equal(Object.hasOwn(result, 'email'), false);
  assert.equal(Object.hasOwn(result, 'plan'), false);
  assert.equal(Object.hasOwn(result, 'role'), false);
  assert.equal(Object.hasOwn(result, 'tutor'), false);
});

test('tutor email remains unchanged', () => {
  const application = makeApplication({ tutorEmail: 'real.tutor@example.com' });
  const tutors = [{ _id: tutorId, name: 'Jane Doe' }];

  const [result] = toStudentApplicationList([application], tutors, toBaseResponse);

  assert.equal(result.tutorEmail, 'real.tutor@example.com');
});

test('missing tutor record returns null safely', () => {
  const application = makeApplication();

  const [withoutTutor] = toStudentApplicationList(
    [application],
    [],
    toBaseResponse
  );
  const [unnamedTutor] = toStudentApplicationList(
    [application],
    [{ _id: tutorId }],
    toBaseResponse
  );
  const [noTutorId] = toStudentApplicationList(
    [makeApplication({ tutorId: null })],
    [{ _id: tutorId, name: 'Jane Doe' }],
    toBaseResponse
  );

  assert.equal(withoutTutor.tutorName, null);
  assert.equal(unnamedTutor.tutorName, null);
  assert.equal(noTutorId.tutorName, null);
});

test('pagination and existing response shape remain unchanged', () => {
  const first = makeApplication();
  const second = makeApplication({
    tutorId: new ObjectId(),
    status: 'accepted',
  });
  const tutors = [
    { _id: first.tutorId, name: 'Jane Doe' },
    { _id: second.tutorId, name: 'John Doe' },
  ];

  const result = toStudentApplicationList(
    [first, second],
    tutors,
    toBaseResponse
  );

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((item) => item.id),
    [first, second].map((item) => item._id.toString())
  );

  for (const item of result) {
    assert.deepEqual(Object.keys(item).sort(), [
      'appliedAt',
      'id',
      'monthlyFee',
      'status',
      'tuitionTitle',
      'tutorEmail',
      'tutorName',
    ]);
  }

  assert.deepEqual(indexTutorNames(tutors).get(first.tutorId.toString()), 'Jane Doe');
  assert.deepEqual(indexTutorNames(tutors).get(second.tutorId.toString()), 'John Doe');
});

test('tutor ids are collected once and queried in a single batch', () => {
  const application = makeApplication();
  const duplicate = makeApplication();

  const ids = collectTutorIds([
    application,
    duplicate,
    makeApplication({ tutorId: null }),
    makeApplication({ tutorId: 'not-an-id' }),
  ]);

  assert.deepEqual(ids, [tutorId.toString()]);

  const query = buildTutorIdQuery(ids);

  assert.equal(query._id.$in.length, 1);
  assert.equal(query._id.$in[0].toString(), tutorId.toString());
});

test('a student only receives their own applications', () => {
  const filter = buildStudentApplicationsFilter(studentId);

  assert.deepEqual(Object.keys(filter), ['studentId']);
  assert.equal(filter.studentId.toString(), studentId.toString());
  assert.equal(
    filter.studentId.toString() ===
      buildStudentApplicationsFilter(new ObjectId()).studentId.toString(),
    false
  );
});
