import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

import paymentRoutes, {
  paymentWebhookRouter,
  PLAN_CATALOG,
  buildPaymentRecord,
  getPlanForRole,
  getUpgradeUserFilter,
  getWebhookAction,
  hasClientCheckoutOverrides,
  resolveClientUrl,
} from '../src/routes/payment.routes.js';

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

    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

function checkoutHandler() {
  const layer = paymentRoutes.stack.find(
    (entry) => entry.route?.path === '/create-checkout-session'
  );

  assert.ok(layer, 'checkout route must exist');
  assert.ok(layer.route.stack.length >= 3, 'checkout must use auth middleware');

  return layer.route.stack.at(-1).handle;
}

function webhookHandler() {
  const layer = paymentWebhookRouter.stack.find(
    (entry) => entry.route?.path === '/' && entry.route.methods.post
  );

  assert.ok(layer, 'webhook route must exist');

  return layer.route.stack.at(-1).handle;
}

test('server catalog uses fixed student and tutor prices', () => {
  assert.equal(PLAN_CATALOG.student.amount, 10);
  assert.equal(PLAN_CATALOG.student.unitAmount, 1000);
  assert.equal(PLAN_CATALOG.student.currency, 'usd');

  assert.equal(PLAN_CATALOG.tutor.amount, 15);
  assert.equal(PLAN_CATALOG.tutor.unitAmount, 1500);
  assert.equal(PLAN_CATALOG.tutor.currency, 'usd');

  assert.equal(getPlanForRole('student').planName, 'Student Pro');
  assert.equal(getPlanForRole('tutor').planName, 'Tutor Pro');
  assert.equal(getPlanForRole('admin'), null);
});

test('checkout rejects any client-supplied overrides', () => {
  for (const body of [
    { role: 'tutor' },
    { amount: 10 },
    { priceId: 'price_123' },
    { userId: new ObjectId().toHexString() },
  ]) {
    assert.equal(hasClientCheckoutOverrides(body), true);
  }

  assert.equal(hasClientCheckoutOverrides(undefined), false);
  assert.equal(hasClientCheckoutOverrides(null), false);
  assert.equal(hasClientCheckoutOverrides({}), false);
  assert.equal(hasClientCheckoutOverrides([]), true);
});

test('client URL resolution uses the first validated origin', async () => {
  await withEnv(
    { CLIENT_URL: 'https://client.example.com,https://backup.example.com/' },
    () => {
      assert.equal(resolveClientUrl(), 'https://client.example.com');
    }
  );

  await withEnv({ CLIENT_URL: 'ftp://invalid.example.com' }, () => {
    assert.equal(resolveClientUrl(), null);
  });
});

test('webhook event routing only handles known payment events', () => {
  assert.equal(getWebhookAction({ type: 'checkout.session.completed' }), 'payment');
  assert.equal(
    getWebhookAction({ type: 'checkout.session.async_payment_succeeded' }),
    'payment'
  );
  assert.equal(
    getWebhookAction({ type: 'customer.subscription.deleted' }),
    'downgrade'
  );
  assert.equal(
    getWebhookAction({
      type: 'customer.subscription.updated',
      data: { object: { status: 'canceled' } },
    }),
    'downgrade'
  );
  assert.equal(
    getWebhookAction({
      type: 'customer.subscription.updated',
      data: { object: { status: 'active' } },
    }),
    null
  );
  assert.equal(getWebhookAction({ type: 'invoice.created' }), null);
});

test('payment record uses verified Stripe data and idempotency keys', () => {
  const userId = new ObjectId();
  const user = {
    _id: userId,
    name: 'Test Student',
    email: 'student@example.test',
    role: 'student',
  };
  const event = { id: 'evt_test_1', created: 1700000000 };
  const session = {
    id: 'cs_test_1',
    amount_total: 1000,
    currency: 'USD',
    payment_intent: { id: 'pi_test_1' },
    subscription: { id: 'sub_test_1' },
  };

  const record = buildPaymentRecord(event, session, user, PLAN_CATALOG.student);

  assert.equal(record.amount, 10);
  assert.equal(record.currency, 'usd');
  assert.equal(record.planName, 'Student Pro');
  assert.equal(record.transactionId, 'pi_test_1');
  assert.equal(record.stripeSessionId, 'cs_test_1');
  assert.equal(record.stripeEventId, 'evt_test_1');
  assert.equal(record.paymentStatus, 'paid');
  assert.equal(record.userRole, 'student');

  const fallback = buildPaymentRecord(
    event,
    { id: 'cs_test_2', payment_intent: null, subscription: { id: 'sub_test_2' } },
    user,
    PLAN_CATALOG.tutor
  );

  assert.equal(fallback.amount, 15);
  assert.equal(fallback.currency, 'usd');
  assert.equal(fallback.transactionId, 'sub_test_2');
});

test('plan upgrade is scoped to the matching role', () => {
  const userId = new ObjectId();

  assert.deepEqual(getUpgradeUserFilter(userId, 'student'), {
    _id: userId,
    role: 'student',
  });
});

test('checkout rejects overrides before touching Stripe or the database', async () => {
  await withEnv({ STRIPE_SECRET_KEY: 'sk_test_dummy' }, async () => {
    const res = makeRes();
    const req = {
      body: { role: 'admin', amount: 999 },
      user: { id: new ObjectId().toHexString() },
      app: { locals: {} },
    };

    await checkoutHandler()(req, res, () => {});

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  });
});

test('webhook rejects missing signatures, non-buffer bodies and bad signatures', async () => {
  await withEnv(
    {
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    },
    async () => {
      const handler = webhookHandler();
      const stripeClient = {
        webhooks: {
          constructEvent() {
            throw new Error('signature verification failed');
          },
        },
      };

      const missingSignature = makeRes();

      await webhookHandler()(
        {
          body: Buffer.from('{}'),
          get: () => undefined,
          app: { locals: { stripeClient } },
        },
        missingSignature,
        () => {}
      );

      assert.equal(missingSignature.statusCode, 400);
      assert.equal(missingSignature.body.message, 'Invalid webhook payload');

      const nonBuffer = makeRes();

      await webhookHandler()(
        {
          body: '{}',
          get: () => 't=1,v1=bad',
          app: { locals: { stripeClient } },
        },
        nonBuffer,
        () => {}
      );

      assert.equal(nonBuffer.statusCode, 400);
      assert.equal(nonBuffer.body.message, 'Invalid webhook payload');

      const badSignature = makeRes();

      await handler(
        {
          body: Buffer.from('{}'),
          get: () => 't=1,v1=bad',
          app: { locals: { stripeClient } },
        },
        badSignature,
        () => {}
      );

      assert.equal(badSignature.statusCode, 400);
      assert.equal(badSignature.body.message, 'Invalid webhook signature');
    }
  );
});
