/**
 * Cross-request serialization for admin account mutations.
 *
 * Counting admins and then updating/deleting one is a classic write-skew
 * race: two requests can both observe two admins and both remove one. A
 * short-lived lock stored on the acting admin's own user document fixes that
 * without a new collection or a replica-set-only transaction.
 *
 * The unique sparse index on `adminLockKey` guarantees at most one holder
 * across every serverless instance. `adminLockAt` lets a later request clear
 * a lock left behind by a crashed or timed-out invocation.
 */

export const ADMIN_LOCK_KEY = 'admin-mutation';
export const ADMIN_LOCK_TTL_MS = 30_000;

export function buildAdminLockIndexSpec() {
  return {
    keys: { adminLockKey: 1 },
    options: {
      unique: true,
      sparse: true,
      name: 'uniq_admin_mutation_lock',
    },
  };
}

export function buildAdminLockAcquireFilter(adminId) {
  return { _id: adminId, adminLockKey: { $exists: false } };
}

export function buildAdminLockAcquireUpdate(now = new Date()) {
  return {
    $set: {
      adminLockKey: ADMIN_LOCK_KEY,
      adminLockAt: now,
    },
  };
}

export function buildStaleAdminLockFilter(now = new Date()) {
  return {
    adminLockKey: ADMIN_LOCK_KEY,
    adminLockAt: { $lt: new Date(now.getTime() - ADMIN_LOCK_TTL_MS) },
  };
}

export function buildAdminLockReleaseFilter(adminId) {
  return { _id: adminId, adminLockKey: ADMIN_LOCK_KEY };
}

export function buildAdminLockReleaseUpdate() {
  return { $unset: { adminLockKey: '', adminLockAt: '' } };
}

export function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

/**
 * Tries to take the global admin-mutation lock for `adminId`.
 * A stale lock is cleared first; a live lock held by anyone else makes the
 * unique index reject this acquisition and returns false.
 */
export async function acquireAdminLock(users, adminId, now = new Date()) {
  await users.updateOne(
    buildStaleAdminLockFilter(now),
    buildAdminLockReleaseUpdate()
  );

  try {
    const result = await users.findOneAndUpdate(
      buildAdminLockAcquireFilter(adminId),
      buildAdminLockAcquireUpdate(now),
      { projection: { _id: 1 } }
    );

    return Boolean(result);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return false;
    }

    throw error;
  }
}

export async function releaseAdminLock(users, adminId) {
  await users.updateOne(
    buildAdminLockReleaseFilter(adminId),
    buildAdminLockReleaseUpdate()
  );
}

/**
 * Runs `fn` while holding the admin-mutation lock. The lock is always
 * released, including when `fn` throws. Returns `{ acquired: false }` when
 * another request kept the lock for the whole retry window.
 */
export async function withAdminLock(
  users,
  adminId,
  fn,
  { attempts = 3, delayMs = 15 } = {}
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await acquireAdminLock(users, adminId)) {
      try {
        return { acquired: true, value: await fn() };
      } finally {
        await releaseAdminLock(users, adminId);
      }
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { acquired: false };
}
