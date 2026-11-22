import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import {
  ADMIN_LOCK_KEY,
  ADMIN_LOCK_TTL_MS,
  acquireAdminLock,
  buildAdminLockAcquireFilter,
  buildAdminLockAcquireUpdate,
  buildAdminLockIndexSpec,
  buildAdminLockReleaseFilter,
  buildAdminLockReleaseUpdate,
  buildStaleAdminLockFilter,
  withAdminLock,
} from '../src/utils/admin-guard.js';

/**
 * Minimal in-memory users collection. It enforces the unique sparse
 * `adminLockKey` rule and supports the small set of operations used by the
 * admin guard, so the real concurrency behaviour can be reproduced in a test.
 */
function createFakeUsers(initialDocuments) {
  const documents = initialDocuments.map((document) => ({ ...document }));

  function findById(id) {
    return documents.find((document) => String(document._id) === String(id));
  }

  return {
    documents,
    async findOne(filter) {
      return findById(filter._id) ?? null;
    },
    async countDocuments({ role }) {
      return documents.filter((document) => document.role === role).length;
    },
    async findOneAndUpdate(filter, update) {
      const document = findById(filter._id);

      if (!document) return null;

      if (update.$set?.adminLockKey !== undefined) {
        if (
          filter.adminLockKey?.$exists === false &&
          document.adminLockKey !== undefined
        ) {
          return null;
        }

        const holder = documents.find(
          (candidate) =>
            candidate.adminLockKey === update.$set.adminLockKey
        );

        if (holder && holder !== document) {
          const error = new Error('duplicate key');
          error.code = 11000;
          throw error;
        }

        Object.assign(document, update.$set);
        return document;
      }

      if (update.$set?.role !== undefined) {
        if (filter.role !== undefined && document.role !== filter.role) {
          return null;
        }

        Object.assign(document, update.$set);
        return document;
      }

      throw new Error('unsupported findOneAndUpdate in fake users collection');
    },
    async updateOne(filter, update) {
      if (update.$unset?.adminLockKey === undefined) {
        throw new Error('unsupported updateOne in fake users collection');
      }

      if (filter._id !== undefined) {
        const document = findById(filter._id);

        if (document && document.adminLockKey === filter.adminLockKey) {
          delete document.adminLockKey;
          delete document.adminLockAt;
          return { modifiedCount: 1 };
        }

        return { modifiedCount: 0 };
      }

      if (filter.adminLockAt?.$lt) {
        let modifiedCount = 0;

        for (const document of documents) {
          if (
            document.adminLockKey === filter.adminLockKey &&
            document.adminLockAt < filter.adminLockAt.$lt
          ) {
            delete document.adminLockKey;
            delete document.adminLockAt;
            modifiedCount += 1;
          }
        }

        return { modifiedCount };
      }

      throw new Error('unsupported updateOne filter in fake users collection');
    },
  };
}

test('admin lock index is unique and sparse', () => {
  const { keys, options } = buildAdminLockIndexSpec();

  assert.deepEqual(keys, { adminLockKey: 1 });
  assert.equal(options.unique, true);
  assert.equal(options.sparse, true);
  assert.equal(options.name, 'uniq_admin_mutation_lock');
});

test('lock filters and updates are scoped to the acting admin', () => {
  const adminId = new ObjectId();
  const now = new Date('2026-01-01T00:00:00.000Z');

  assert.deepEqual(buildAdminLockAcquireFilter(adminId), {
    _id: adminId,
    adminLockKey: { $exists: false },
  });
  assert.deepEqual(buildAdminLockAcquireUpdate(now), {
    $set: { adminLockKey: ADMIN_LOCK_KEY, adminLockAt: now },
  });
  assert.deepEqual(buildAdminLockReleaseFilter(adminId), {
    _id: adminId,
    adminLockKey: ADMIN_LOCK_KEY,
  });
  assert.deepEqual(buildAdminLockReleaseUpdate(), {
    $unset: { adminLockKey: '', adminLockAt: '' },
  });
  assert.deepEqual(buildStaleAdminLockFilter(now), {
    adminLockKey: ADMIN_LOCK_KEY,
    adminLockAt: { $lt: new Date(now.getTime() - ADMIN_LOCK_TTL_MS) },
  });
});

test('only one request can hold the admin lock at a time', async () => {
  const adminA = new ObjectId();
  const adminB = new ObjectId();
  const users = createFakeUsers([
    { _id: adminA, role: 'admin' },
    { _id: adminB, role: 'admin' },
  ]);

  assert.equal(await acquireAdminLock(users, adminA), true);
  assert.equal(await acquireAdminLock(users, adminB), false);
  assert.equal(users.documents[0].adminLockKey, ADMIN_LOCK_KEY);
  assert.equal(users.documents[1].adminLockKey, undefined);
});

test('a stale lock left by a crashed request is reclaimed', async () => {
  const adminA = new ObjectId();
  const adminB = new ObjectId();
  const users = createFakeUsers([
    {
      _id: adminA,
      role: 'admin',
      adminLockKey: ADMIN_LOCK_KEY,
      adminLockAt: new Date(Date.now() - ADMIN_LOCK_TTL_MS - 1_000),
    },
    { _id: adminB, role: 'admin' },
  ]);

  assert.equal(await acquireAdminLock(users, adminB), true);

  const holderA = users.documents.find(
    (document) => String(document._id) === String(adminA)
  );
  const holderB = users.documents.find(
    (document) => String(document._id) === String(adminB)
  );

  assert.equal(holderA.adminLockKey, undefined);
  assert.equal(holderB.adminLockKey, ADMIN_LOCK_KEY);
});

test('the lock is released even when the critical section throws', async () => {
  const admin = new ObjectId();
  const users = createFakeUsers([{ _id: admin, role: 'admin' }]);

  await assert.rejects(
    withAdminLock(
      users,
      admin,
      async () => {
        throw new Error('boom');
      },
      { attempts: 1, delayMs: 0 }
    ),
    /boom/
  );

  assert.equal(users.documents[0].adminLockKey, undefined);
});

test('simultaneous demotions can never remove every admin', async () => {
  const adminA = new ObjectId();
  const adminB = new ObjectId();
  const users = createFakeUsers([
    { _id: adminA, role: 'admin' },
    { _id: adminB, role: 'admin' },
  ]);

  async function demote(actorId, targetId) {
    const outcome = await withAdminLock(
      users,
      actorId,
      async () => {
        const target = await users.findOne({ _id: targetId });

        if (!target) return 'missing';

        if (target.role === 'admin') {
          const adminCount = await users.countDocuments({ role: 'admin' });

          if (adminCount <= 1) return 'last-admin-blocked';
        }

        await users.findOneAndUpdate(
          { _id: targetId, role: target.role },
          { $set: { role: 'student' } }
        );

        return 'demoted';
      },
      { attempts: 20, delayMs: 0 }
    );

    assert.equal(outcome.acquired, true);
    return outcome.value;
  }

  const results = await Promise.all([
    demote(adminA, adminB),
    demote(adminB, adminA),
  ]);

  const remainingAdmins = users.documents.filter(
    (document) => document.role === 'admin'
  );

  assert.equal(remainingAdmins.length, 1);
  assert.equal(results.filter((result) => result === 'demoted').length, 1);
  assert.equal(
    results.filter((result) => result === 'last-admin-blocked').length,
    1
  );
});
