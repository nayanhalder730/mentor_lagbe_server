import 'dotenv/config';
import Stripe from 'stripe';

import { connectToDatabase, closeDatabase } from '../src/config/db.js';
import {
  applySuccessfulCheckoutUpgrade,
  buildReconciliationEvent,
  getCheckoutIdentity,
  getCheckoutPaymentDecision,
} from '../src/routes/payment.routes.js';

/**
 * Reconciles one already-paid Checkout Session without creating a new charge.
 * Safe to run more than once: payment records are deduplicated by session and
 * the Pro plan update is idempotent.
 */
async function main() {
  const sessionId = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

  if (!sessionId || !sessionId.startsWith('cs_')) {
    throw new Error('Usage: npm run reconcile:payment -- <CHECKOUT_SESSION_ID>');
  }

  const key = process.env.STRIPE_SECRET_KEY;

  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  await connectToDatabase();

  const stripe = new Stripe(key);
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  const decision = getCheckoutPaymentDecision(session);

  if (decision !== 'upgrade') {
    throw new Error(
      `Checkout Session is not a paid subscription checkout (${decision}); no change made.`
    );
  }

  if (!getCheckoutIdentity(session)) {
    throw new Error('Checkout Session is missing a valid user identity; no change made.');
  }

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;

  if (!subscriptionId) {
    throw new Error('Checkout Session has no subscription; no change made.');
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  if (subscription.status !== 'active') {
    throw new Error(
      `Subscription status is ${subscription.status}, not active; no change made.`
    );
  }

  await applySuccessfulCheckoutUpgrade(buildReconciliationEvent(session));

  console.log(
    `Reconciliation complete for Checkout Session ${sessionId}: Pro plan is active.`
  );
}

main()
  .catch((error) => {
    console.error(
      'Reconciliation failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch(() => {});
  });
