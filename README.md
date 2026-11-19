# MentorLagbe — Server

Express REST API for **MentorLagbe**. It provides public tuition browsing, JWT-protected student/tutor/admin workflows, Better Auth JWKS verification, admin moderation, dashboard statistics and Stripe subscription handling.

> Deployment URL: **TODO — add the verified live API URL here after deployment.**
> No live URL is committed in this repository.

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

## Deployment (Render)

1. Create a Web Service from this repository.
2. Runtime: Node.js. Build command: `npm install`. Start command: `npm start`.
3. Add the environment variables from the table above in the Render dashboard.
4. Set `PORT` to the port provided by the host if required.
5. Set `BETTER_AUTH_URL` and `CLIENT_URL` to the deployed client origin(s).
6. Point the client's `NEXT_PUBLIC_API_URL` to this service.
7. Register `<API origin>/api/payments/webhook` in Stripe with the same signing secret.
8. Verify `GET /api/health` after deployment.

No Render URL is documented here; add the verified URL after deployment.

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
