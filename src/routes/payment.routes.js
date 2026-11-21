import { Router } from 'express';
import Stripe from 'stripe';
import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';
import {
  verifyToken,
  verifyAdmin,
  authorizeRoles,
} from '../middleware/auth.middleware.js';

const PAYMENTS_COLLECTION = 'payments';
const USERS_COLLECTION = 'user';

// Server-side price catalog. Prices are never accepted from the client and
// always derive from the role stored in the database.
export const PLAN_CATALOG = {
  student: {
    planName: 'Student Pro',
    amount: 10,
    currency: 'usd',
    unitAmount: 1000,
  },
  tutor: {
    planName: 'Tutor Pro',
    amount: 15,
    currency: 'usd',
    unitAmount: 1500,
  },
};

export const PAYMENT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

export const DOWNGRADE_SUBSCRIPTION_STATUSES = new Set([
  'canceled',
  'unpaid',
  'incomplete_expired',
]);

const DEFAULT_CLIENT_URL = 'http://localhost:3000';

// Public payment shape. Internal `userId` and `stripeEventId` fields are
// intentionally excluded.
const PAYMENT_PROJECTION = {
  userEmail: 1,
  userName: 1,
  userRole: 1,
  planName: 1,
  amount: 1,
  currency: 1,
  transactionId: 1,
  stripeSessionId: 1,
  paymentStatus: 1,
  paidAt: 1,
};

const router = Router();
export const paymentWebhookRouter = Router();
export const adminPaymentRouter = Router();

let stripeCache = { key: null, client: null };
let paymentIndexPromise = null;

function paymentsCollection() {
  return getDb().collection(PAYMENTS_COLLECTION);
}

function usersCollection() {
  return getDb().collection(USERS_COLLECTION);
}

/**
 * Returns the Stripe client for the current secret key.
 * `app.locals.stripeClient` allows embedding a preconfigured client (used by
 * integration tests); the environment key is still required first.
 */
function getStripeClient(app) {
  const key = process.env.STRIPE_SECRET_KEY;

  if (typeof key !== 'string' || key.trim() === '') {
    return null;
  }

  if (app?.locals?.stripeClient) {
    return app.locals.stripeClient;
  }

  if (!stripeCache.client || stripeCache.key !== key) {
    stripeCache = {
      key,
      client: new Stripe(key),
    };
  }

  return stripeCache.client;
}

/**
 * Creates the indexes needed for idempotent webhook handling and payment
 * history lookups. Existing data is never dropped or modified.
 */
function ensurePaymentIndexes() {
  if (!paymentIndexPromise) {
    paymentIndexPromise = (async () => {
      const collection = paymentsCollection();

      await collection.createIndex(
        { stripeSessionId: 1 },
        { unique: true, sparse: true, name: 'uniq_stripe_session' }
      );
      await collection.createIndex(
        { stripeEventId: 1 },
        { unique: true, sparse: true, name: 'uniq_stripe_event' }
      );
      await collection.createIndex(
        { userId: 1, paidAt: -1 },
        { name: 'user_paid_at' }
      );
    })().catch((error) => {
      paymentIndexPromise = null;
      throw error;
    });
  }

  return paymentIndexPromise;
}

function toObjectId(value) {
  if (value instanceof ObjectId) {
    return value;
  }

  if (typeof value !== 'string' || !ObjectId.isValid(value)) {
    return null;
  }

  return new ObjectId(value);
}

function toPaymentResponse(document) {
  return {
    id: document._id.toString(),
    userEmail: document.userEmail,
    userName: document.userName,
    userRole: document.userRole,
    planName: document.planName,
    amount: document.amount,
    currency: document.currency,
    transactionId: document.transactionId ?? null,
    stripeSessionId: document.stripeSessionId ?? null,
    paymentStatus: document.paymentStatus,
    paidAt: document.paidAt ?? null,
  };
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves the configured client origin for Stripe redirects.
 * Supports the same comma-separated format used for CORS origins.
 */
export function resolveClientUrl() {
  const configured = process.env.CLIENT_URL || DEFAULT_CLIENT_URL;
  const firstOrigin = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)[0];

  if (!firstOrigin) {
    return null;
  }

  try {
    const parsed = new URL(firstOrigin);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
  } catch {
    return null;
  }

  return firstOrigin.replace(/\/+$/, '');
}

export function normalizeStripeId(value) {
  if (typeof value === 'string' && value !== '') {
    return value;
  }

  if (value && typeof value === 'object' && typeof value.id === 'string') {
    return value.id;
  }

  return null;
}

/**
 * Rejects any client-supplied checkout fields. Amounts, roles, plans, and
 * identity are always resolved from the authenticated database user.
 */
export function hasClientCheckoutOverrides(body) {
  if (body === undefined || body === null) {
    return false;
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    return true;
  }

  return Object.keys(body).length > 0;
}

/** Resolves the server-controlled plan for a database role. */
export function getPlanForRole(role) {
  return PLAN_CATALOG[role] ?? null;
}

/** Extracts the authenticated user id from Stripe session metadata. */
export function getCheckoutIdentity(session) {
  const raw = session?.metadata?.userId || session?.client_reference_id;
  return toObjectId(raw);
}

/** Extracts the Stripe Subscription ID from a Checkout Session. */
export function getCheckoutSubscriptionId(session) {
  const value = session?.subscription;

  if (typeof value === 'string' && value.startsWith('sub_')) return value;
  if (
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    value.id.startsWith('sub_')
  ) {
    return value.id;
  }

  return null;
}

/** Only an active subscription grants Pro for these paid monthly plans. */
export function isActiveSubscription(subscription) {
  return subscription?.status === 'active';
}

/** Compares the subscription metadata user to the checkout identity. */
export function subscriptionMatchesIdentity(subscription, userId) {
  if (!userId) return false;

  const metadataUserId = subscription?.metadata?.userId;

  return (
    typeof metadataUserId !== 'string' || metadataUserId === userId.toHexString()
  );
}

/**
 * Decides whether a verified checkout session represents a paid subscription.
 * `no_payment_required` is deliberately not treated as a paid purchase: the
 * catalog only sells positive-amount monthly plans and has no trial flow.
 */
export function getCheckoutPaymentDecision(session) {
  if (!session || session.object !== 'checkout.session') return 'unrelated';
  if (session.mode !== 'subscription') return 'unrelated';
  if (session.status && session.status !== 'complete') return 'incomplete';

  if (session.payment_status === 'paid') return 'upgrade';
  if (session.payment_status === 'no_payment_required') {
    return 'no_payment_required';
  }
  if (session.payment_status === 'unpaid') return 'unpaid';

  return 'unknown_payment_status';
}

/** Builds a synthetic event for safe reconciliation of an existing session. */
export function buildReconciliationEvent(session, now = Math.floor(Date.now() / 1000)) {
  return {
    id: `reconcile_${session.id}`,
    type: 'checkout.session.completed',
    created: now,
    data: { object: session },
  };
}

function logWebhook(eventType, sessionId, outcome, details = {}) {
  console.info(
    'stripe-webhook',
    JSON.stringify({ eventType, sessionId, outcome, ...details })
  );
}

/** Maps a verified Stripe event to the database action it should trigger. */
export function getWebhookAction(event) {
  if (!event || typeof event !== 'object') return null;

  if (PAYMENT_EVENTS.has(event.type)) return 'payment';

  if (event.type === 'customer.subscription.deleted') return 'downgrade';

  if (
    event.type === 'customer.subscription.updated' &&
    DOWNGRADE_SUBSCRIPTION_STATUSES.has(event.data?.object?.status)
  ) {
    return 'downgrade';
  }

  return null;
}

/** Builds the persisted payment record from verified Stripe event data. */
export function buildPaymentRecord(event, session, user, plan) {
  const amountTotal = Number.isSafeInteger(session.amount_total)
    ? session.amount_total
    : plan.unitAmount;
  const paidAt = Number.isFinite(event.created)
    ? new Date(event.created * 1000)
    : new Date();

  return {
    userEmail: user.email ?? '',
    userName: user.name ?? '',
    userRole: user.role,
    planName: plan.planName,
    // Stripe reports minor units; store major currency units (10 = $10.00).
    amount: Math.round(amountTotal) / 100,
    currency:
      typeof session.currency === 'string' && session.currency !== ''
        ? session.currency.toLowerCase()
        : plan.currency,
    transactionId:
      normalizeStripeId(session.payment_intent) ||
      normalizeStripeId(session.subscription) ||
      session.id,
    stripeSessionId: session.id,
    paymentStatus: 'paid',
    paidAt,
    userId: user._id,
    stripeEventId: event.id,
  };
}

/** Only a matching student/tutor account may be upgraded by a payment. */
export function getUpgradeUserFilter(userId, role) {
  return { _id: userId, role };
}

/**
 * POST /api/payments/create-checkout-session
 * Creates a Stripe Checkout subscription session for the verified user.
 */
router.post(
  '/create-checkout-session',
  verifyToken,
  authorizeRoles('student', 'tutor'),
  async (req, res) => {
    if (hasClientCheckoutOverrides(req.body)) {
      return res.status(400).json({
        success: false,
        message:
          'Checkout details are determined by your verified account; request body fields are not accepted',
      });
    }

    const stripe = getStripeClient(req.app);

    if (!stripe) {
      return res.status(500).json({
        success: false,
        message: 'Payment service is not configured',
      });
    }

    const clientUrl = resolveClientUrl();

    if (!clientUrl) {
      return res.status(500).json({
        success: false,
        message: 'Payment service is not configured',
      });
    }

    const userId = toObjectId(req.user.id);

    if (!userId) {
      return res.status(404).json({
        success: false,
        message: 'Profile not found',
      });
    }

    // Role, plan, name, and email come from the database, not the JWT or body.
    const user = await usersCollection().findOne(
      { _id: userId },
      { projection: { name: 1, email: 1, role: 1, plan: 1 } }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Profile not found',
      });
    }

    const plan = getPlanForRole(user.role);

    if (!plan) {
      return res.status(403).json({
        success: false,
        message: 'Only students and tutors can purchase a subscription',
      });
    }

    if (user.plan === 'pro') {
      return res.status(409).json({
        success: false,
        message: 'You are already on the Pro plan',
      });
    }

    const metadata = {
      userId: userId.toHexString(),
      userRole: user.role,
      planName: plan.planName,
    };

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email: user.email,
        client_reference_id: userId.toHexString(),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: plan.currency,
              unit_amount: plan.unitAmount,
              recurring: { interval: 'month' },
              product_data: { name: `MentorLagbe ${plan.planName}` },
            },
          },
        ],
        success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/payment/cancel`,
        metadata,
        subscription_data: { metadata },
      });

      if (!session || typeof session.url !== 'string' || session.url === '') {
        throw new Error('Stripe did not return a checkout URL');
      }

      return res.status(201).json({
        success: true,
        message: 'Checkout session created',
        data: {
          url: session.url,
          sessionId: session.id,
          planName: plan.planName,
          amount: plan.amount,
          currency: plan.currency,
        },
      });
    } catch (error) {
      console.error(
        'Stripe checkout session creation failed:',
        error?.type || error?.message || 'unknown error'
      );

      return res.status(502).json({
        success: false,
        message: 'Unable to start checkout. Please try again later.',
      });
    }
  }
);

/**
 * GET /api/payments/my
 * The authenticated user's own payment history, newest first.
 */
router.get('/my', verifyToken, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 20);

  if (page === null) {
    return res.status(400).json({
      success: false,
      message: 'page must be a positive integer',
    });
  }

  if (limit === null || limit > 100) {
    return res.status(400).json({
      success: false,
      message: 'limit must be a positive integer between 1 and 100',
    });
  }

  const userId = toObjectId(req.user.id);

  if (!userId) {
    return res.status(404).json({
      success: false,
      message: 'Profile not found',
    });
  }

  const filter = { userId };
  const collection = paymentsCollection();
  const total = await collection.countDocuments(filter);
  const payments = await collection
    .find(filter, { projection: PAYMENT_PROJECTION })
    .sort({ paidAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return res.json({
    success: true,
    message: 'Payments retrieved successfully',
    data: {
      payments: payments.map(toPaymentResponse),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
});

/**
 * Applies a verified paid subscription checkout to the database.
 *
 * Relevant events that cannot be fully processed now throw so the webhook can
 * return a retryable 5xx. Unrelated or unpaid events are acknowledged with a
 * structured log and never upgrade the user.
 */
export async function applySuccessfulCheckoutUpgrade(event, deps = {}) {
  const {
    users = usersCollection(),
    payments = paymentsCollection(),
    ensureIndexes = ensurePaymentIndexes,
    log = logWebhook,
    verifySubscription,
  } = deps;

  const session = event?.data?.object;
  const eventType = event?.type ?? 'unknown';
  const sessionId = typeof session?.id === 'string' ? session.id : null;
  const decision = getCheckoutPaymentDecision(session);

  if (decision !== 'upgrade') {
    log(eventType, sessionId, 'ignored', { reason: decision });
    return;
  }

  const userId = getCheckoutIdentity(session);

  if (!userId || !sessionId) {
    log(eventType, sessionId, 'invalid');
    throw new Error('Checkout session is missing required identity');
  }

  log(eventType, sessionId, 'processing');

  const user = await users.findOne(
    { _id: userId },
    { projection: { name: 1, email: 1, role: 1 } }
  );

  if (!user) {
    log(eventType, sessionId, 'user_not_found');
    throw new Error('Checkout user was not found');
  }

  if (
    typeof session.metadata?.userRole === 'string' &&
    session.metadata.userRole !== user.role
  ) {
    log(eventType, sessionId, 'role_mismatch');
    throw new Error('Checkout role does not match the account role');
  }

  const plan = getPlanForRole(user.role);

  if (!plan) {
    log(eventType, sessionId, 'role_not_eligible');
    throw new Error('Checkout user role is not eligible for Pro');
  }

  const subscriptionId = getCheckoutSubscriptionId(session);

  if (!subscriptionId) {
    log(eventType, sessionId, 'subscription_missing');
    throw new Error('Checkout session has no subscription');
  }

  if (typeof verifySubscription !== 'function') {
    log(eventType, sessionId, 'subscription_verifier_missing');
    throw new Error('Subscription verification is unavailable');
  }

  const subscription = await verifySubscription(subscriptionId);

  if (!isActiveSubscription(subscription)) {
    log(eventType, sessionId, 'subscription_not_active');
    throw new Error('Subscription is not active');
  }

  if (!subscriptionMatchesIdentity(subscription, userId)) {
    log(eventType, sessionId, 'subscription_identity_mismatch');
    throw new Error('Subscription identity does not match checkout identity');
  }

  await ensureIndexes();

  const existingPayment = await payments.findOne(
    {
      $or: [
        { stripeEventId: event.id },
        { stripeSessionId: sessionId },
      ],
    },
    { projection: { _id: 1 } }
  );

  if (!existingPayment) {
    const payment = buildPaymentRecord(event, session, user, plan);

    try {
      await payments.insertOne(payment);
    } catch (error) {
      // A concurrent delivery may have inserted this event/session first.
      if (error?.code !== 11000) {
        log(eventType, sessionId, 'payment_record_failed');
        throw error;
      }

      log(eventType, sessionId, 'payment_record_duplicate');
    }
  }

  const result = await users.updateOne(
    getUpgradeUserFilter(userId, user.role),
    { $set: { plan: 'pro' } }
  );

  log(eventType, sessionId, 'upgrade_attempted', {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  });

  if (result.matchedCount === 0) {
    throw new Error('User upgrade matched no account');
  }
}

/** Backwards-compatible name used by the webhook route. */
export async function handleCheckoutPayment(event, deps) {
  return applySuccessfulCheckoutUpgrade(event, deps);
}

/**
 * Reverts a student/tutor to the free plan when their subscription is
 * canceled or otherwise no longer active.
 */
async function handleSubscriptionDowngrade(subscription) {
  const userId = toObjectId(subscription?.metadata?.userId);

  if (!userId) {
    return;
  }

  await usersCollection().updateOne(
    { _id: userId, role: { $in: ['student', 'tutor'] } },
    { $set: { plan: 'free' } }
  );
}

/**
 * Retrieves a subscription from Stripe for webhook verification.
 */
async function retrieveStripeSubscription(app, subscriptionId) {
  const stripe = getStripeClient(app);

  if (!stripe) {
    throw new Error('Payment service is not configured');
  }

  return stripe.subscriptions.retrieve(subscriptionId);
}

/**
 * POST /api/payments/webhook
 * Mounted with express.raw() before the global JSON parser so the Stripe
 * signature can be verified against the exact raw payload.
 */
paymentWebhookRouter.post('/', async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = getStripeClient(req.app);

  if (!webhookSecret || !stripe) {
    return res.status(500).json({
      success: false,
      message: 'Payment webhook is not configured',
    });
  }

  const signature = req.get('stripe-signature');

  if (!signature || !Buffer.isBuffer(req.body)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid webhook payload',
    });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      webhookSecret
    );
  } catch {
    return res.status(400).json({
      success: false,
      message: 'Invalid webhook signature',
    });
  }

  try {
    const action = getWebhookAction(event);

    if (action === 'payment') {
      await handleCheckoutPayment(event, {
        verifySubscription: (subscriptionId) =>
          retrieveStripeSubscription(req.app, subscriptionId),
      });
    } else if (action === 'downgrade') {
      await handleSubscriptionDowngrade(event.data?.object);
    }

    return res.json({ received: true });
  } catch (error) {
    console.error(
      'Stripe webhook processing failed:',
      error?.message || 'unknown error'
    );

    return res.status(500).json({
      success: false,
      message: 'Webhook processing failed',
    });
  }
});

/**
 * GET /api/admin/payments
 * Admin-only paginated listing of all payment records.
 */
adminPaymentRouter.get('/', verifyToken, verifyAdmin, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 20);

  if (page === null) {
    return res.status(400).json({
      success: false,
      message: 'page must be a positive integer',
    });
  }

  if (limit === null || limit > 100) {
    return res.status(400).json({
      success: false,
      message: 'limit must be a positive integer between 1 and 100',
    });
  }

  const collection = paymentsCollection();
  const total = await collection.countDocuments();
  const payments = await collection
    .find({}, { projection: PAYMENT_PROJECTION })
    .sort({ paidAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return res.json({
    success: true,
    message: 'Payments retrieved successfully',
    data: {
      payments: payments.map(toPaymentResponse),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
});

export default router;
