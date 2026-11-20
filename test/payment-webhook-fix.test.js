import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import {
  paymentWebhookRouter,
  applySuccessfulCheckoutUpgrade,
  buildReconciliationEvent,
  getCheckoutIdentity,
  getCheckoutPaymentDecision,
} from '../src/routes/payment.routes.js';

function makePaidSession(userId = new ObjectId()) {
  return {
    object: 'checkout.session',
    id: 'cs_test_paid',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 1000,
    currency: 'usd',
    metadata: {
      userId: userId.toHexString(),
      userRole: 'student',
      planName: 'Student Pro',
    },
    client_reference_id: userId.toHexString(),
    payment_intent: { id: 'pi_test_1' },
  };
}

function makeEvent(session, type = 'checkout.session.completed') {
  return {
    id: 'evt_test_paid',
    type,
    created: 1700000000,
    data: { object: session },
  };
}

function makeDeps(options = {}) {
  const {
    user = { _id: options.userId ?? new ObjectId(), name: 'Test', email: 'test@example.test', role: 'student' },
    existingPayment = null,
    updateResult = { matchedCount: 1, modifiedCount: true },
    insertError = null,
    updateError = null,
  } = options;

  const calls = { findUser: 0, findPayment: 0, insert: 0, update: 0 };
  const logs = [];

  const deps = {
    users: {
      async findOne() {
        calls.findUser += 1;
        return user;
      },
      async updateOne() {
        calls.update += 1;
        if (updateError) throw updateError;
        return updateResult;
      },
    },
    payments: {
      async findOne() {
        calls.findPayment += 1;
        return existingPayment;
      },
      async insertOne() {
        calls.insert += 1;
        if (insertError) throw insertError;
        return { insertedId: new ObjectId() };
      },
    },
    async ensureIndexes() {},
    log(...args) {
      logs.push(args);
    },
  };

  return { deps, calls, logs };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function withEnv(values, fn) {
  const saved = new Map();

  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('paid subscription checkout is upgraded and recorded', async () => {
  const userId = new ObjectId();
  const { deps, calls, logs } = makeDeps({ userId });

  await applySuccessfulCheckoutUpgrade(makeEvent(makePaidSession(userId)), deps);

  assert.equal(calls.update, 1);
  assert.equal(calls.insert, 1);
  assert.ok(logs.some((entry) => entry[2] === 'upgrade_attempted'));
});

test('unpaid and no_payment_required sessions never upgrade the user', async () => {
  const userId = new ObjectId();

  for (const paymentStatus of ['unpaid', 'no_payment_required']) {
    const session = { ...makePaidSession(userId), payment_status: paymentStatus };
    const { deps, calls, logs } = makeDeps({ userId });

    await applySuccessfulCheckoutUpgrade(makeEvent(session), deps);

    assert.equal(calls.update, 0);
    assert.equal(calls.findUser, 0);
    assert.ok(logs.some((entry) => entry[2] === 'ignored'));
  }

  assert.equal(
    getCheckoutPaymentDecision({ object: 'checkout.session', payment_status: 'paid', mode: 'payment' }),
    'unrelated'
  );
  assert.equal(
    getCheckoutPaymentDecision({
      object: 'checkout.session',
      payment_status: 'paid',
      mode: 'subscription',
      status: 'open',
    }),
    'incomplete'
  );
});

test('missing metadata is a processing failure, not a successful acknowledgement', async () => {
  const session = makePaidSession();
  delete session.metadata;
  delete session.client_reference_id;

  const { deps, calls } = makeDeps();

  assert.equal(getCheckoutIdentity(session), null);
  await assert.rejects(
    () => applySuccessfulCheckoutUpgrade(makeEvent(session), deps),
    /missing required identity/
  );
  assert.equal(calls.findUser, 0);
});

test('missing user and zero matched documents are processing failures', async () => {
  const userId = new ObjectId();

  const missingUser = makeDeps({ user: null });

  await assert.rejects(
    () => applySuccessfulCheckoutUpgrade(makeEvent(makePaidSession(userId)), missingUser.deps),
    /user was not found/
  );

  const unmatched = makeDeps({
    userId,
    updateResult: { matchedCount: 0, modifiedCount: 0 },
  });

  await assert.rejects(
    () => applySuccessfulCheckoutUpgrade(makeEvent(makePaidSession(userId)), unmatched.deps),
    /matched no account/
  );
});

test('database failures propagate instead of being acknowledged', async () => {
  const userId = new ObjectId();
  const failingUpdate = makeDeps({
    userId,
    updateError: new Error('database unavailable'),
  });

  await assert.rejects(() =>
    applySuccessfulCheckoutUpgrade(makeEvent(makePaidSession(userId)), failingUpdate.deps)
  );

  const failingInsert = makeDeps({
    userId,
    insertError: new Error('insert failed'),
  });

  await assert.rejects(() =>
    applySuccessfulCheckoutUpgrade(makeEvent(makePaidSession(userId)), failingInsert.deps)
  );
});

test('duplicate webhook delivery skips insert but still upgrades idempotently', async () => {
  const userId = new ObjectId();
  const { deps, calls } = makeDeps({
    userId,
    existingPayment: { _id: new ObjectId() },
  });

  await applySuccessfulCheckoutUpgrade(makeEvent(makePaidSession(userId)), deps);

  assert.equal(calls.insert, 0);
  assert.equal(calls.update, 1);
});

test('reconciliation event wraps an existing session without creating a charge', () => {
  const session = makePaidSession();
  const event = buildReconciliationEvent(session, 1700000000);

  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(event.id, `reconcile_${session.id}`);
  assert.equal(event.data.object, session);
  assert.equal(getCheckoutPaymentDecision(event.data.object), 'upgrade');
});

test('webhook returns 500 for a relevant event that cannot be processed', async () => {
  await withEnv(
    {
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    },
    async () => {
      const session = makePaidSession();
      delete session.metadata;
      delete session.client_reference_id;

      const stripeClient = {
        webhooks: {
          constructEvent() {
            return makeEvent(session);
          },
        },
      };

      const res = makeRes();
      const handler = paymentWebhookRouter.stack.find(
        (entry) => entry.route?.path === '/' && entry.route.methods.post
      ).route.stack.at(-1).handle;

      await handler(
        {
          body: Buffer.from('{}'),
          get: () => 't=1,v1=test',
          app: { locals: { stripeClient } },
        },
        res,
        () => {}
      );

      assert.equal(res.statusCode, 500);
    }
  );
});

test('webhook still acknowledges unrelated event types', async () => {
  await withEnv(
    {
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    },
    async () => {
      const stripeClient = {
        webhooks: {
          constructEvent() {
            return { id: 'evt_unrelated', type: 'invoice.created', data: { object: {} } };
          },
        },
      };

      const res = makeRes();
      const handler = paymentWebhookRouter.stack.find(
        (entry) => entry.route?.path === '/' && entry.route.methods.post
      ).route.stack.at(-1).handle;

      await handler(
        {
          body: Buffer.from('{}'),
          get: () => 't=1,v1=test',
          app: { locals: { stripeClient } },
        },
        res,
        () => {}
      );

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { received: true });
    }
  );
});
