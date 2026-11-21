# MentorLagbe — Server

Express REST API for **MentorLagbe**. It provides public tuition browsing, JWT-protected student/tutor/admin workflows, Better Auth JWKS verification, admin moderation, dashboard statistics and Stripe subscription handling.

> Server live URL: https://mentor-lagbe-server-v7ji.vercel.app

---

## Repository URLs

- Server: https://github.com/nayanhalder730/mentor_lagbe_server
- Client: https://github.com/nayanhalder730/mentor_lagbe_client

---

## Submission Information

| Item | Value |
| --- | --- |
| Admin credentials | **OWNER TO PROVIDE BEFORE SUBMISSION** — no verified admin account exists in the repository. |
| Tutor test credentials | **OWNER TO PROVIDE BEFORE SUBMISSION** — no verified tutor demo account exists in the repository. |
| Live site URL (client) | https://mentor-lagbe-client-dun.vercel.app |
| Live API URL (server) | https://mentor-lagbe-server-v7ji.vercel.app |
| Client repository | https://github.com/nayanhalder730/mentor_lagbe_client |
| Server repository | https://github.com/nayanhalder730/mentor_lagbe_server |

Do not invent credentials or URLs for submission; add only verified values.

**What the owner must supply:** a real admin email + password (a user in the shared Better Auth `user` collection with `role: "admin"`) and, optionally, a tutor demo email + password. Never publish a personal or production password.

---

## Features

- Health check with MongoDB connectivity status.
- Better Auth JWT verification through a remote JWKS endpoint; role-based middleware (`verifyToken`, `verifyStudent`, `verifyTutor`, `verifyAdmin`).
- User profile endpoints, admin user listing/role changes, and student-only Saved Tuitions.
- Public tuition listing/detail restricted to approved and active tuitions.
- Tutor tuition CRUD, tutor-owned active-status toggle, and admin approval/moderation.
- Student applications with duplicate prevention, status review, and pending-only cancellation.
- Role-specific dashboard overview statistics.
- Stripe Checkout session creation, payment history, admin payment listing, and signed webhook handling that updates user plans.
- Idempotent tuition seed script guarded against production use.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js with ES modules |
| Framework | Express 5 |
| Database | MongoDB via the `mongodb` driver |
| Auth | Better Auth JWT plugin + `jose` JWKS verification |
| Payments | Stripe Checkout + webhooks |
| Config | `dotenv` |
| Tests | Node's built-in `node:test` runner |

---

## Main npm packages

| Package | Purpose |
| --- | --- |
| `express`, `cors` | HTTP API and CORS |
| `mongodb` | MongoDB driver and collections |
| `better-auth` | Better Auth integration/library |
| `jose` | JWT verification against the Better Auth JWKS |
| `jsonwebtoken` | JWT utility dependency present in the project |
| `stripe` | Checkout sessions and webhook verification |
| `dotenv` | Environment loading |
| `nodemon` | Development auto-reload |

Tests use Node's built-in `node:test`; no test framework dependency is installed.

---

## Prerequisites

- Node.js 20+
- npm
- MongoDB (local or hosted)
- A running MentorLagbe client for Better Auth JWKS and CORS
- Stripe test-mode keys for local payment testing

---

## Installation & Local Development

```bash
cd mentor_lagbe_server
npm install
cp .env.example .env
# Fill in .env. Never commit it.
npm run dev
```

The API listens on `PORT` (default `8000`). Verify it with `GET /api/health`.

---

## Environment Variables

The table below uses the exact names present in `mentor_lagbe_server/.env.example`.

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string. |
| `PORT` | HTTP port for the Express API. |
| `BETTER_AUTH_URL` | Client origin used for the JWKS URL, JWT issuer/audience. |
| `CLIENT_URL` | Public client origin for Stripe redirects and default CORS origin. Comma-separated origins are supported. |
| `STRIPE_SECRET_KEY` | Server-only Stripe secret key. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret used to verify webhook payloads. |

Two additional variables are read by the code but are not present in `.env.example`:

| Variable | Purpose |
| --- | --- |
| `DB_NAME` | Optional database-name override; otherwise derived from `MONGODB_URI` or `mentor_lagbe`. |
| `NODE_ENV` | Used by the seed script; must be `development` or `test` to seed. |

This backend does **not** use `JWT_SECRET` or `IMGBB_KEY`; authentication uses Better Auth JWKS, and image uploads are performed directly by the client through ImgBB.

---

## API Endpoints

All paths below are relative to the API origin. Protected endpoints expect `Authorization: Bearer <JWT>`.

### Health

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/api/health` | Public |

### Users / Profile / Saved Tuitions

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/api/users/me` | Authenticated |
| `PATCH` | `/api/users/me` | Authenticated |
| `GET` | `/api/users/me/saved-tuitions` | Student |
| `POST` | `/api/users/me/saved-tuitions/:tuitionId` | Student |
| `DELETE` | `/api/users/me/saved-tuitions/:tuitionId` | Student |
| `GET` | `/api/users` | Admin |
| `PATCH` | `/api/users/:id/role` | Admin |

### Public Tuitions

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/api/tuitions` | Public |
| `GET` | `/api/tuitions/:id` | Public |

Both public routes only expose approved, active tuitions.

### Tutor Tuitions

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/api/tuitions/my` | Tutor |
| `POST` | `/api/tuitions` | Tutor |
| `PATCH` | `/api/tuitions/:id` | Tutor (owner) |
| `DELETE` | `/api/tuitions/:id` | Tutor (owner) |
| `PATCH` | `/api/tuitions/:id/status` | Tutor (owner) |

The content update endpoint accepts only tuition content fields. The status endpoint accepts only `{ "isActive": boolean }` and only for approved tuitions.

### Admin Tuitions

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/api/admin/tuitions` | Admin |
| `PATCH` | `/api/admin/tuitions/:id/approval` | Admin |
| `PATCH` | `/api/admin/tuitions/:id/status` | Admin |

### Applications

| Method | Path | Access |
| --- | --- | --- |
| `POST` | `/api/applications` | Student |
| `GET` | `/api/applications/check?tuitionId=<id>` | Student |
| `GET` | `/api/applications/my` | Student |
| `GET` | `/api/applications/tutor` | Tutor |
| `PATCH` | `/api/applications/:id/status` | Tutor (owner) |
| `DELETE` | `/api/applications/:id` | Student (owner) |

### Dashboard

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/api/dashboard/overview` | Authenticated |

The response includes a `role` discriminator and role-specific statistics.

### Payments / Stripe

| Method | Path | Access |
| --- | --- | --- |
| `POST` | `/api/payments/create-checkout-session` | Student or Tutor |
| `GET` | `/api/payments/my` | Authenticated |
| `GET` | `/api/admin/payments` | Admin |
| `POST` | `/api/payments/webhook` | Stripe signature |

---

## Authentication

`src/middleware/auth.middleware.js` verifies JWTs with `jose`:

- The issuer/audience come from `BETTER_AUTH_URL`.
- Public keys are fetched from `<BETTER_AUTH_URL>/api/auth/jwks`.
- The JWKS resolver is cached per URL.
- Verified role claims are checked by `verifyStudent`, `verifyTutor` and `verifyAdmin`.
- No password hash, token, session or private auth field is returned by API projections.

---

## Data Architecture

Better Auth owns its internal MongoDB collections (such as `user`, `account`, `session`, `verification` and JWKS data). This project does **not** claim that the database physically contains exactly four collections.

The four domain data areas are:

- **`tuitions`** — tuition posts.
- **`applications`** — student applications.
- **`payments`** — verified payment records.
- **Better Auth user/profile data** — user identity plus role/plan/phone/bio and `savedTuitionIds`.

Saved Tuitions reuse the existing `user` document; no extra collection is created.

---

## Stripe Webhook Setup

- Endpoint path: `POST /api/payments/webhook`.
- The route is mounted with `express.raw()` before `express.json()` so the exact raw body can be signature-verified.
- Configure `STRIPE_WEBHOOK_SECRET` with the signing secret for this endpoint.
- Required events handled:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `customer.subscription.deleted`
  - `customer.subscription.updated` (only for `canceled`, `unpaid` or `incomplete_expired`)
- Requests without a Stripe signature or with an invalid signature return `400`.
- `CLIENT_URL` controls the Checkout `success_url`/`cancel_url` origins.

Live Stripe webhook delivery is not configured or verified in this repository.

### Reconcile an already paid Checkout Session

If a payment succeeded but the user is still on `free`, reconcile the existing Checkout Session instead of charging again:

1. Stripe Dashboard → switch to the same mode used for the payment (Test or Live).
2. Open **Payments** or **Checkout Sessions**, find the successful payment, and copy the Checkout Session ID beginning with `cs_`.
   - The ID may also be present in the success URL as `?session_id=cs_...` or in the admin payment list as `stripeSessionId`.
3. Run locally with the same `STRIPE_SECRET_KEY`, `MONGODB_URI` and `DB_NAME` used by the deployed API:

```bash
npm run reconcile:payment -- cs_TEST_SESSION_ID
```

The script retrieves the session from Stripe, verifies paid subscription status and the active subscription, checks the stored user, then applies the same idempotent Pro upgrade used by the webhook. It never creates a Checkout Session or charge and is safe to rerun.

---

## Seed Script

```bash
npm run seed:tuitions -- --confirm --allow-database <exact-database-name>
```

Safety rules implemented in `scripts/seed-tuitions.js`:

- `--confirm` is required.
- `--allow-database` must exactly match the configured database name.
- `NODE_ENV` must be `development` or `test`.
- Databases named `admin`, `local`, `config`, or matching `/prod/i` are rejected.
- The seed is namespace/idempotency protected and requires existing tutor users.
- Production seeding is intentionally blocked.

Do not run this script against production data.

---

## Testing

```bash
npm test
```

Tests use Node's built-in `node:test` runner and cover validation, authorization wiring, atomic update filters, projections and conflict responses. No database connection is required for the unit tests.

---

## CORS

Allowed origins are derived from `CLIENT_URL` (comma-separated). The default when unset is `http://localhost:3000`.

For production, include the deployed client origin exactly, including scheme. If the client is served from multiple origins, list all of them. Credentials are not used for the Express API; authentication is Bearer-token based.

---

## Deployment (Vercel)

The repository ships a `vercel.json` rewrite and the live API is deployed at
`https://mentor-lagbe-server-v7ji.vercel.app`.

1. Import this repository into Vercel (the included `vercel.json` routes requests to `api/index.js`).
2. Add the environment variables from the table above in the Vercel project settings.
3. Set `BETTER_AUTH_URL` and `CLIENT_URL` to the deployed client origin (`https://mentor-lagbe-client-dun.vercel.app`).
4. Point the client's `NEXT_PUBLIC_API_URL` to `https://mentor-lagbe-server-v7ji.vercel.app`.
5. Register `https://mentor-lagbe-server-v7ji.vercel.app/api/payments/webhook` in Stripe with the same signing secret.
6. Verify `GET /api/health` after deployment.

Webhook delivery and live Pro activation require Stripe Dashboard access and are
not verified in this repository. Use `npm run reconcile:payment -- <session-id>`
if a checkout completed while the webhook was not registered.

---

## Production Deployment Checklist

- [ ] `MONGODB_URI` points to the intended production database.
- [ ] `BETTER_AUTH_URL` and `CLIENT_URL` use the deployed HTTPS origins.
- [ ] `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set from Stripe **live** mode only when ready.
- [ ] Stripe webhook endpoint is registered and signature verification succeeds.
- [ ] CORS allows only trusted client origins.
- [ ] No seed script has been run against production.
- [ ] Health endpoint returns `status: "ok"`.
- [ ] JWT-protected routes reject missing/expired tokens.
- [ ] No environment values or secrets are committed.
