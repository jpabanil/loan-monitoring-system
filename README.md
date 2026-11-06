# Loan Monitoring System

Member mobile app and staff admin for a lending company. The design and acceptance tests are in [plan.md](plan.md); working rules are in [CLAUDE.md](CLAUDE.md).

## Repository

```
apps/api/           Fastify API + PostgreSQL (Drizzle ORM, pg-boss jobs)
apps/admin-web/     Next.js staff admin: glass UI, light/dark/system theme (sample data for now)
packages/shared/    Money (centavos + decimal.js), amortization, allocation, penalty, aging, RBAC
```

Still to come: `apps/member-app` (React Native / Expo), the member-facing API routes, and connecting the admin web to the API.

## First-time setup

Needs Node 22+ and PostgreSQL 17 (`brew install postgresql@17 && brew services start postgresql@17`). pnpm comes through Corepack.

```bash
corepack pnpm install
cp apps/api/.env.example apps/api/.env      # development values only
corepack pnpm db:setup                      # roles lms_owner + lms_app, databases lms_dev + lms_test
corepack pnpm db:migrate
corepack pnpm db:seed                       # plan test data: staff, Products A/B, members M1/M2
```

## Run

```bash
corepack pnpm dev:api      # API on http://localhost:4000, OpenAPI docs at /docs
corepack pnpm worker       # nightly jobs: overdue/penalty 00:30, integrity 01:00 (Asia/Manila)
corepack pnpm dev          # admin web on http://localhost:3000
corepack pnpm test         # shared + API integration tests (real PostgreSQL)
```

Seeded staff sign in with their email (`admin@`, `manager@`, `manager2@`, `officer@`, `cashier@`, `auditor@example.com`) and the development password printed by `db:seed`, then set up two-factor with any authenticator app.

To run the daily job by hand for a given date (for example to walk through the AT-OVD tests): `corepack pnpm --filter @lms/api job:daily 2027-01-05`.

## API notes

- Money is always **integer centavos** in requests and responses (₱4,727.98 → `472798`).
- Staff sign-in: `POST /api/v1/auth/staff/login` → `2fa/setup` + `2fa/confirm` (first time) or `2fa/verify`. The session is set as httpOnly cookies; the access token is also returned for non-browser clients.
- `POST /payments` and `POST /loan-applications/:id/release` accept an `Idempotency-Key` header.
- `FIXED_DATE=YYYY-MM-DD` pins the business date outside production (UAT and tests).

## Database roles

| Role | Used by | Can do |
|---|---|---|
| `lms_owner` | migrations | Creates tables, constraints and grants (`apps/api/src/db/rules.ts`) |
| `lms_app` | API and worker | Read/write data; **insert and select only** on `ledger_entries` and `audit_logs`; no `DELETE` on anything tied to money |

The worker's queue (pg-boss) uses `JOBS_DATABASE_URL`, a role allowed to create pg-boss's own schema; the job work itself runs as `lms_app`.

## Admin web status

The admin screens still run on **sample data** held in the browser (`apps/admin-web/src/lib/sample-data.ts`), not on the API. Connecting them is the next step.
