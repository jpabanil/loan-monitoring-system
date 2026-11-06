# Loan Monitoring System: Development Plan and Acceptance Tests

**Prepared by:** Jonah Pacas-Abanil, CpE  
**Date:** November 6, 2026  
**Stack:** TypeScript · Fastify (API) · PostgreSQL · React/Next.js (admin web) · React Native (member mobile app)  
**Version:** 1.1 (stack changed from FastAPI/MongoDB to Fastify/PostgreSQL; admin web moved to Next.js; added append-only ledger with nightly integrity check, approver-cannot-release rule and staff two-factor login)

---

## 1. Purpose and Scope

This document defines how the Loan Monitoring System will be built and how it will be accepted. It covers:

- **Member Mobile App** (Android and iOS): registration, loan applications, balances, payment history, schedules, reminders and notifications.
- **Admin Web System** (computer browser): staff access control, member management, loan products, loan processing, payment posting, overdue monitoring, reports and transaction history.
- **System Management**: secure database, real-time synchronization, backup and recovery, audit trail and a user-friendly interface.

Out of scope for version 1, available as change requests: online payments (GCash/Maya/bank gateway), SMS gateway integration, e-signature on loan agreements, accounting/general ledger, multi-branch consolidation and credit bureau (CIC) submission.

> **Note on sample figures.** Interest rates, penalties, fees and reminder schedules in this document are sample settings that make the tests concrete. They will be replaced with the company's actual loan policies in Phase 1. Every one of them is configurable in the admin system.

---

## 2. Architecture

| Layer | Technology | Notes |
|---|---|---|
| Member Mobile App | React Native (Expo), TypeScript | One codebase for Android 8+ and iOS 15+. Secure token storage; optional fingerprint/Face ID unlock |
| Admin Web System | Next.js 15 (App Router), React 19, TypeScript, TanStack Query, Ant Design | Runs in Chrome, Edge and Firefox on office computers; no installation. Next.js serves the UI only; all business logic and data access go through the Fastify API |
| API Server | Node.js 22 LTS, Fastify 5, TypeScript (strict), Zod via `fastify-type-provider-zod` | REST JSON API with OpenAPI docs (`@fastify/swagger`); single API for both apps |
| Shared code | `packages/shared` workspace package | Zod request/response schemas, API types, money and amortization functions shared by the API, admin web and member app (display only on clients; the server is the source of truth) |
| Database | PostgreSQL 17 (managed, e.g. AWS RDS / DigitalOcean Managed PostgreSQL, or self-hosted) | ACID transactions, foreign keys, CHECK and UNIQUE constraints protect financial data at the database level |
| Data access | Drizzle ORM + `node-postgres` (pg); migrations with `drizzle-kit` | Typed SQL with explicit transactions and `SELECT … FOR UPDATE`; every schema change is a versioned migration |
| Background jobs | pg-boss (job queue stored in PostgreSQL) | Daily overdue/penalty run, reminder dispatch, report generation. No separate Redis needed |
| Real-time sync | WebSocket channel (`@fastify/websocket`, admin) + push notifications (mobile) + cache refresh on app open | PostgreSQL `LISTEN/NOTIFY` fans events out across API instances. A payment posted by staff updates the member app within seconds |
| Push notifications | Expo Push Service (FCM for Android, APNs for iOS) | |
| File storage | S3-compatible object storage (AWS S3 or DigitalOcean Spaces) | Private bucket, short-lived signed URLs for IDs and documents |
| Reports | ExcelJS (Excel), HTML templates rendered to PDF with Playwright/Chromium | |
| Hosting | Linux VPS, Docker Compose, Nginx reverse proxy, Let's Encrypt SSL | Containers: `api`, `worker`, `admin-web` (Next.js standalone output), `postgres` (if self-hosted). Staging and production environments |
| CI/CD | GitHub Actions, pnpm workspaces | Lint, type check, tests, build, deploy to staging |
| Monitoring | Sentry (errors), Uptime monitor, structured JSON logs (Pino) | |

### 2.1 Key design decisions

1. **Money is stored as integer centavos (`BIGINT`)** in PostgreSQL, for example ₱4,727.98 is stored as `472798`. All calculations use `decimal.js` with ROUND_HALF_UP to the centavo, in one shared money module. JavaScript floats are never used for money arithmetic. Every money column has a `CHECK (amount >= 0)` constraint where negatives are not valid.
2. **Financial postings use PostgreSQL transactions.** Loan release, payment posting and payment voiding update the loan, its installments, the payment record and the audit log in one transaction. If any step fails, nothing is saved.
3. **Row locking plus optimistic locking.** Posting locks the loan row with `SELECT … FOR UPDATE`, and loans carry a `version` column checked on update, so two cashiers posting against the same loan at the same moment are serialized and balances are never corrupted.
4. **Loan product terms are snapshotted** into each loan at release (`product_snapshot JSONB`). Changing a product later never changes existing loans.
5. **Append-only ledger is the source of truth.** Every money movement (release, fee, interest, penalty, waiver, payment, void) is written as rows in `ledger_entries` by one posting service, in the same transaction as the balance update and the audit entry. No other code writes ledger entries. Ledger entries and payments are never edited or deleted: a void writes reversing entries that point to the originals, and the payment is then re-posted if needed. The application database role has no `UPDATE`, `DELETE` or `TRUNCATE` privilege on `ledger_entries` and no `DELETE` privilege on other financial tables.
6. **Stored balances are a cache.** The balance columns on `loans` and `installments` exist for fast reads. A nightly integrity job recomputes every loan's balances from `ledger_entries` and raises an alert on any mismatch (see 5.7).
7. **Append-only, hash-chained audit log** for every create, update, approve, release, post, void and login event. Each entry stores the hash of the previous entry, so a removed or altered entry breaks the chain. The application role has `INSERT` and `SELECT` only on `audit_logs`; `UPDATE`, `DELETE` and `TRUNCATE` are revoked.
8. **Database constraints back up the business rules:** unique OR number, one loan per application, one penalty per installment per period, one reminder per installment per trigger. A bug or a race in application code cannot create duplicates.
9. **Timezone:** all timestamps are stored as `TIMESTAMPTZ` (UTC) and displayed in Asia/Manila. Due dates are `DATE` columns.

---

## 3. Users, Roles and Permissions

| Permission | Admin | Manager | Loan Officer | Cashier | Auditor | Member (app) |
|---|---|---|---|---|---|---|
| Manage staff users and roles | ✔ | | | | | |
| Configure loan products, penalties, settings | ✔ | ✔ | | | | |
| Register and edit members | ✔ | ✔ | ✔ | | | Own profile (key fields need approval) |
| Approve member registration from app | ✔ | ✔ | ✔ | | | |
| Encode and review loan applications | ✔ | ✔ | ✔ | | | Apply and track own |
| Approve or decline loans | ✔ | ✔ | | | | |
| Release loans | ✔ | ✔ | | | | |
| Post payments | ✔ | ✔ | | ✔ | | |
| Void payments | ✔ | ✔ | | | | |
| View monitoring dashboard | ✔ | ✔ | ✔ | ✔ | ✔ | |
| Generate and export reports | ✔ | ✔ | ✔ | ✔ (collections only) | ✔ | |
| View audit trail | ✔ | ✔ | | | ✔ | |
| View own loans, payments and schedule | | | | | | ✔ |

**Segregation of duties (four-eyes control, enforced in the API service layer, on by default):**

- The staff member who encoded a loan application cannot approve it.
- The staff member who approved a loan cannot release it; another Manager or Admin releases.
- A cashier can never waive a penalty or void a payment (only Manager and Admin can).

**Staff two-factor login:** every staff account must sign in with a password plus a 6-digit code from an authenticator app (TOTP). Members use password plus optional biometric unlock on their phone.

---

## 4. Data Model (PostgreSQL Tables)

All tables have `id BIGINT GENERATED ALWAYS AS IDENTITY` (or UUID for externally visible IDs), `created_at` and `updated_at TIMESTAMPTZ`. Money columns are `BIGINT` centavos. Status columns are PostgreSQL enums or `TEXT` with a `CHECK` list. Foreign keys are enforced on every reference.

| Table | Key columns | Constraints and indexes |
|---|---|---|
| `staff_users` | name, email, password_hash (Argon2id), role, status, totp_secret (encrypted), totp_enabled_at, recovery_code_hashes TEXT[], failed_logins, locked_until, last_login_at | unique email (case-insensitive, `citext`) |
| `refresh_tokens` | user_type (staff/member), user_id, token_hash, family_id, expires_at, revoked_at | unique token_hash; (user_type, user_id) |
| `members` | member_no, first/middle/last name, birthdate, sex, civil_status, address, mobile, email, employment/income source, gov_id_type, gov_id_number, gov_id_file_key, photo_key, status (pending, active, suspended, closed), consent_version, consent_accepted_at, created_by | unique member_no; unique mobile; GIN trigram index (`pg_trgm`) on names for partial search |
| `member_accounts` | member_id, username, password_hash, verified_at | PK/FK member_id; unique username |
| `member_change_requests` | member_id, changes JSONB, status (pending, approved, rejected), reviewed_by, reviewed_at | (member_id, status) |
| `documents` | owner_type (member, application), owner_id, doc_type, file_key, uploaded_by | (owner_type, owner_id) |
| `loan_products` | code, name, interest_rate NUMERIC(9,6), rate_period (monthly/annual), method (diminishing, add_on), terms_allowed INT[], frequency (weekly, semi_monthly, monthly), min_amount, max_amount, fees JSONB [{name, type: percent/fixed, value, deducted_from_proceeds}], penalty_rate, penalty_basis, grace_days, max_active_loans, active | unique code; CHECK min_amount ≤ max_amount |
| `loan_applications` | application_no, member_id, product_id, amount, term, frequency, purpose, channel (mobile, walk_in), status (submitted, under_review, approved, declined, cancelled, released), encoded_by, approved_by | unique application_no; (member_id, status) |
| `application_status_history` | application_id, status, changed_by, changed_at, remarks | (application_id, changed_at) |
| `loans` | loan_no, application_id, member_id, product_snapshot JSONB, principal, total_interest, fees JSONB, net_proceeds, release_date, first_due_date, maturity_date, status (active, past_due, fully_paid, restructured, written_off), principal_balance, interest_balance, penalty_balance, total_balance, days_past_due, version | unique loan_no; **unique application_id** (prevents double release); (member_id, status); status; CHECK balances ≥ 0 |
| `installments` | loan_id, schedule_version, seq, due_date, principal_due, interest_due, penalty_due, principal_paid, interest_paid, penalty_paid, penalty_waived, status (unpaid, partial, paid, overdue), paid_at. The schedule is generated once at release and never edited; a restructure creates a new schedule_version | unique (loan_id, schedule_version, seq); (due_date, status); CHECK paid ≤ due for each component |
| `penalty_assessments` | installment_id, loan_id, period_no, amount, assessed_for_date (waivers are recorded on `installments.penalty_waived` and as `penalty_waiver` ledger entries) | **unique (installment_id, period_no)** (makes the daily job idempotent) |
| `payments` | receipt_no (OR number), loan_id, member_id, amount, method (cash, bank, e_wallet, check), reference_no, payment_date, advance_amount, received_by, status (posted, voided), void_reason, voided_by, voided_at, idempotency_key | unique receipt_no; unique idempotency_key; (loan_id, payment_date); payment_date; CHECK amount > 0 |
| `ledger_entries` | loan_id, member_id, installment_id (nullable), entry_type (release, fee, interest, penalty, penalty_waiver, payment, reversal), component (principal, interest, penalty, fee), amount (signed centavos: + increases what the member owes, − reduces it), currency, payment_id (nullable), penalty_assessment_id (nullable), reverses_entry_id (nullable), effective_date, posted_by, posted_at | (loan_id, posted_at); (member_id, effective_date); unique reverses_entry_id (an entry can be reversed only once). `INSERT`/`SELECT` only for the app role |
| `payment_allocations` | payment_id, installment_id, penalty, interest, principal | (payment_id); (installment_id) |
| `idempotency_keys` | key, actor_id, endpoint, request_hash, response JSONB, created_at | unique (actor_id, key); expired after 24 hours |
| `notifications` | member_id, type, title, body, data JSONB, channels TEXT[], installment_id, trigger, sent_at, read_at | (member_id, created_at); **unique (installment_id, trigger)** where installment_id is not null (no duplicate reminders) |
| `devices` | member_id, push_token, platform, last_seen_at | unique push_token |
| `audit_logs` | actor_type, actor_id, actor_name, action, entity, entity_id, before JSONB, after JSONB, ip INET, user_agent, at, prev_hash, hash | (entity, entity_id); at; actor_id. `INSERT`/`SELECT` only for the app role |
| `settings` | company profile, reminder schedule, quiet hours, payment allocation order, segregation_of_duties, password policy (JSONB value per key) | one row per key |

**Numbering:** member_no, loan_no and application_no come from PostgreSQL sequences (one per series, formatted in the service, e.g. `M-2026-000001`). OR numbers are entered by the cashier and protected by the unique constraint.

**Retention:** members and loans are never hard-deleted; they are closed or archived. Audit logs are read-only to every role, enforced by database privileges.

---

## 5. Business Rules

### 5.1 Amortization

- **Diminishing balance:** fixed installment `A = P × r ÷ (1 − (1 + r)^−n)`, where `r` is the rate per period. Interest per period = outstanding principal × r. The last installment absorbs any rounding difference so the principal ends at exactly ₱0.00.
- **Add-on (flat):** total interest = P × r × n. Installment = (P + total interest) ÷ n. Principal and interest are spread evenly, and the last installment absorbs rounding.
- **Due dates:** the first due date is one period after the release date, unless set manually at release. If a day-of-month does not exist (for example the 31st), the last day of that month is used.

### 5.2 Fees and proceeds

- Fees are computed at release. Fees marked "deducted from proceeds" reduce the net cash released. Other fees are added to the first installment.

### 5.3 Payment allocation

- Default order per installment: **penalty → interest → principal**, oldest unpaid installment first.
- Amounts beyond all currently due installments are applied to the next installments in order, as an advance payment. A setting can apply excess to principal instead.
- A payment greater than the total outstanding balance is rejected.
- The loan becomes **fully paid** when all balances reach ₱0.00. The member is notified, and a fully paid notice can be printed.

### 5.4 Overdue and penalty

- An installment becomes **overdue** the day after its due date if not fully paid.
- A **penalty** is assessed after the grace period: penalty rate × unpaid installment amount (principal + interest) for each 30-day period, or part of a period, past due. Sample setting: 3% per month, 3 grace days.
- A daily job runs at 00:30 Asia/Manila to update statuses, days past due, penalties and aging buckets. The job is **idempotent**: running it twice on the same day does not add a second penalty.
- **Aging buckets:** Current, 1–30, 31–60, 61–90 and 90+ days past due.
- Staff with Manager role can waive a penalty with a required reason, which is audited.

### 5.5 Loan application and eligibility

- Only **active** members can apply.
- The amount must be within the product's minimum and maximum, and the term must be one the product allows.
- A member cannot exceed the product's `max_active_loans`.
- Status flow: submitted → under review → approved / declined → released. A member can cancel only while the status is submitted.

### 5.6 Reminders

- Sample schedule: 3 days before the due date, on the due date, 1 day after, then every 7 days while overdue.
- Reminders are sent only between 8:00 AM and 8:00 PM Asia/Manila. A reminder is never sent twice for the same installment and trigger.

### 5.7 Ledger and integrity

- **Release** writes entries for principal, total scheduled interest and each fee. **Penalty assessment** and **waiver** write penalty and penalty_waiver entries. **Payment** writes one negative entry per component paid, matching its allocation. **Void** writes a reversal entry for each of the payment's entries.
- A loan's balance for each component is the sum of its ledger entries. The member ledger report (AT-RPT-05) is read straight from `ledger_entries`.
- A nightly integrity job (after the overdue run) recomputes every loan's and installment's balances from the ledger and compares them with the stored balances, and verifies the audit log hash chain. Any mismatch sends an alert to Admin and is logged; balances are never corrected silently.

---

## 6. API Outline (Fastify, `/api/v1`)

Routes are Fastify plugins, one per area. Every route declares Zod schemas for params, query, body and response; RBAC runs as a `preHandler` hook. Staff auth in the admin web uses httpOnly, Secure, SameSite cookies; the mobile app uses bearer tokens kept in secure storage.

| Area | Endpoints |
|---|---|
| Staff auth | `POST /auth/staff/login`, `POST /auth/staff/2fa/verify`, `POST /auth/staff/2fa/setup`, `POST /auth/staff/2fa/confirm`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/staff/change-password` |
| Member auth | `POST /auth/member/register`, `POST /auth/member/verify-otp`, `POST /auth/member/login`, `POST /auth/member/forgot-password` |
| Staff users | `GET/POST /staff-users`, `PATCH /staff-users/{id}`, `POST /staff-users/{id}/unlock`, `POST /staff-users/{id}/reset-2fa` |
| Members | `GET/POST /members`, `GET/PATCH /members/{id}`, `POST /members/{id}/approve`, `POST /members/{id}/suspend`, `GET /members/{id}/ledger` (from `ledger_entries`) |
| Loan products | `GET/POST /loan-products`, `PATCH /loan-products/{id}` |
| Calculator | `POST /loan-products/{id}/preview-schedule` |
| Applications | `GET/POST /loan-applications`, `GET /loan-applications/{id}`, `POST /…/{id}/review`, `/approve`, `/decline`, `/cancel` |
| Loans | `POST /loan-applications/{id}/release`, `GET /loans`, `GET /loans/{id}`, `GET /loans/{id}/schedule`, `POST /loans/{id}/waive-penalty` |
| Payments | `POST /payments`, `GET /payments`, `GET /payments/{id}`, `POST /payments/{id}/void`, `GET /payments/{id}/receipt.pdf` |
| Dashboard | `GET /dashboard/summary`, `GET /dashboard/aging`, `GET /dashboard/due-today` |
| Reports | `GET /reports/{type}?from=&to=&format=pdf|xlsx` |
| Member app | `GET /me`, `PATCH /me`, `GET /me/loans`, `GET /me/loans/{id}`, `GET /me/payments`, `GET/POST /me/applications`, `GET /me/notifications`, `POST /me/notifications/{id}/read`, `POST /me/devices` |
| Audit | `GET /audit-logs` |
| Real-time | `WS /ws/admin` (events: payment.posted, application.submitted, loan.status_changed) |
| Health | `GET /health` |

All write endpoints that post money accept an `Idempotency-Key` header, so a double-click or network retry never posts a payment twice. The key is stored in `idempotency_keys` inside the same transaction as the posting, and a repeat request returns the original response.

---

## 7. Screens

### 7.1 Member Mobile App

1. Welcome, Login, Register (personal info, ID upload, selfie optional, consent), OTP verification, Forgot password
2. Home: total outstanding balance, next due date and amount, overdue banner, quick actions
3. My Loans: list, then Loan Detail (balance breakdown, progress, amortization schedule, remaining installments)
4. Payment History: list with filters, then Payment Detail (OR number, allocation)
5. Apply for a Loan: choose product, amount, term, preview schedule, upload documents, submit
6. My Applications: status timeline
7. Notifications inbox
8. Profile and settings: contact details, change password, biometric unlock, logout

### 7.2 Admin Web System

1. Login, two-factor code, two-factor setup (QR code and recovery codes), Change password
2. Dashboard: portfolio outstanding, released this month, collections today/month, due today, overdue count and amount, aging chart, recent activity (live)
3. Members: list/search, Member profile (info, documents, loans, ledger), Pending app registrations
4. Loan Products: list and editor with schedule preview
5. Applications: queue by status, Application detail (review, approve/decline, release)
6. Loans: list with filters, Loan detail (schedule, payments, penalties, waive)
7. Payments: Post payment (search member/loan, amount, OR number, allocation preview), Payment list, Void
8. Overdue Monitoring: past-due list by aging bucket, with contact details and export
9. Reports
10. Staff Users and Roles
11. Settings
12. Audit Trail

### 7.3 Reports (PDF and Excel)

Loan releases · Collections (daily/period, by cashier) · Outstanding balances · Past due / aging · Member ledger · Loan amortization schedule · Payment history / transaction history · Fully paid loans · Penalty assessed and waived · Official receipt reprint.

---

## 8. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Security | HTTPS only; Argon2id password hashing (`@node-rs/argon2`); TOTP two-factor login required for all staff (secrets encrypted at rest, one-time recovery codes, Admin can reset); parameterized SQL only (no string-built queries); `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cors`; JWT access tokens (15 min) with rotating refresh tokens; account lockout after 5 failed logins for 15 minutes; rate limiting on auth endpoints; RBAC enforced on the server for every endpoint; input validation; private file storage with signed URLs; secrets in environment variables |
| Data privacy | Aligned with the Data Privacy Act of 2012 (RA 10173): consent captured at registration, least-privilege access, audit trail, encrypted backups, privacy notice in app |
| Performance | API p95 response under 500 ms for normal operations with 50,000 members and 200 concurrent users; reports for one month of data generated under 30 seconds |
| Real-time | Payment posted by staff visible in the member app within 10 seconds when the app is open; push notification within 1 minute |
| Availability | 99.5% monthly target; scheduled maintenance announced in advance |
| Backup and recovery | Automated daily encrypted backup (`pgBackRest` or the managed provider's snapshots) kept for 30 days, plus weekly kept for 12 weeks, stored off-server; continuous WAL archiving for point-in-time recovery; RPO 24 hours (near zero with WAL archiving / managed PITR); RTO 4 hours; restore tested before go-live |
| Usability | Mobile app usable by first-time smartphone users; large tap targets; English labels (Filipino optional); every list searchable; destructive actions require confirmation |
| Compatibility | Android 8.0+, iOS 15+; Chrome, Edge, Firefox (latest two versions); admin screens from 1366×768 |
| Maintainability | TypeScript strict mode across all packages; ESLint and Prettier; versioned database migrations; automated tests in CI; README and deployment runbook |

---

## 9. Repository Structure

```
loan-monitoring/                 # pnpm workspace monorepo
├── apps/
│   ├── api/                     # Fastify + TypeScript
│   │   ├── src/
│   │   │   ├── routes/v1/       # plugins: auth, members, products, applications, loans, payments, reports, me
│   │   │   ├── plugins/         # auth, rbac, audit, idempotency, websocket, db
│   │   │   ├── db/
│   │   │   │   ├── schema/      # Drizzle table definitions
│   │   │   │   └── migrations/  # drizzle-kit SQL migrations (incl. grants and constraints)
│   │   │   ├── services/        # amortization.ts, allocation.ts, penalty.ts, posting.ts, notifications.ts, reports/
│   │   │   ├── jobs/            # pg-boss workers: daily-overdue.ts, reminders.ts, reports.ts
│   │   │   ├── server.ts        # Fastify app factory
│   │   │   └── worker.ts        # background job entry point
│   │   └── test/                # unit/, integration/, acceptance/
│   ├── admin-web/               # Next.js (App Router) + TypeScript
│   └── member-app/              # React Native (Expo) + TypeScript
├── packages/
│   └── shared/                  # Zod schemas, API types, money.ts (decimal.js helpers)
├── infra/                       # docker-compose.yml, nginx/, backup scripts, GitHub Actions
└── docs/                        # this plan, API docs, runbook, user guides
```

---

## 10. Delivery Plan (10 Weeks)

| Phase | Weeks | Key tasks | Exit criteria |
|---|---|---|---|
| 1. Requirements and design | 1 | Confirm loan products, interest methods, penalty and fee rules, OR numbering, roles, report formats; collect sample forms and a real amortization sheet; UI wireframes for app and admin; finalize data model | Client sign-off on business rules sheet and wireframes; sample figures in Section 5 replaced with actual policies |
| 2. Foundation | 2 | Monorepo (pnpm workspaces), CI, Docker, staging server, PostgreSQL with migrations, roles and grants; staff auth with TOTP 2FA, RBAC, hash-chained audit log plugin; Next.js admin shell; member app shell | Staff can log in on staging; RBAC tests pass |
| 3. Members and products | 3 | Member CRUD, documents upload, member app registration + OTP + approval; loan products and schedule preview; amortization engine with unit tests | AT-MEM and AT-PRD tests pass; amortization matches the client's sample sheet to the centavo |
| 4. Applications and release | 4 | Application flow (admin and app), approval with segregation of duties, ledger posting service, release with fees, ledger entries and schedule generation, loan detail | AT-APP and AT-REL tests pass |
| 5. Payments and monitoring | 5 | Payment posting with allocation and ledger entries, OR numbers, idempotency, voiding with reversal entries, receipts; dashboard; daily overdue/penalty job; nightly integrity job; aging | AT-PAY, AT-OVD and AT-LED tests pass; **Admin System demo to client (payment milestone 2)** |
| 6. Member app features | 6–7 | Home, loans, schedule, payment history, applications, notifications inbox, profile, biometric unlock; push notifications and reminders; real-time updates | AT-MOB, AT-NTF and AT-SYNC tests pass on Android and iOS test builds |
| 7. Reports and hardening | 8 | All reports in PDF and Excel; audit trail screen; backups and restore drill; security review; performance test with seeded 50,000 members | AT-RPT, AT-BKP, AT-SEC and AT-PERF tests pass |
| 8. UAT | 9 | Client staff run the acceptance tests on staging with realistic data; fix defects; data migration of existing loans if needed | All Critical and High defects closed; UAT sign-off |
| 9. Go-live and training | 10 | Production deployment, app store submissions, staff training (admin, cashier, manager), user guides, handover of source code and credentials | Production live; apps published or in store review; **turnover (final milestone)** |

### 10.1 Definition of Done (each feature)

Code reviewed and merged · unit and integration tests written and passing in CI · RBAC applied on the server · audit log entries created for every state change · works on staging · related acceptance tests pass · no open Critical/High defects.

### 10.2 Defect severity

| Severity | Definition | UAT gate |
|---|---|---|
| Critical | Wrong money computation, data loss, security breach, system unusable | Must be fixed before go-live |
| High | Core feature blocked with no workaround | Must be fixed before go-live |
| Medium | Feature works with a workaround or minor wrong behavior | Fixed before go-live or scheduled in warranty with client agreement |
| Low | Cosmetic, wording, layout | Fixed during warranty |

---

## 11. Testing Strategy

| Level | Tools | Coverage target |
|---|---|---|
| Unit | Vitest, fast-check (property tests for amortization and allocation) | 90% on `services/` (financial logic), 80% overall API |
| Integration | Vitest + Fastify `inject()` + real PostgreSQL in Docker (Testcontainers) | All API endpoints, transactions, rollbacks, constraint violations, RBAC denials |
| Admin E2E | Playwright | Critical paths: login, register member, apply, approve, release, post payment, void, reports |
| Mobile E2E | Maestro (Android emulator and iOS simulator) | Register, login, view loan, apply, notifications |
| Performance | k6 | Section 8 targets with seeded data |
| Security | OWASP ZAP baseline scan, dependency audit (`pnpm audit`), container image scan | No High findings open at go-live |
| UAT | Client staff using the acceptance tests below | 100% of Critical-priority tests pass |

**Property tests** that must always hold: sum of installment principal = loan principal; final principal balance = ₱0.00; allocation never pays more than is due; balances never go negative; void + re-post returns the loan to the same state; after any sequence of postings, the sum of ledger entries equals the stored balances.

---

## 12. Acceptance Tests

**Test data (sample settings, replaced in Phase 1):**

- **Product A, "Regular Loan":** diminishing balance, 2% per month, monthly, terms 6–24 months, ₱5,000–₱200,000, processing fee 2% deducted from proceeds, penalty 3% per month of unpaid installment, 3 grace days, max 1 active loan.
- **Product B, "Quick Loan":** add-on, 1.5% per month, monthly, terms 3–6 months, ₱1,000–₱30,000, no fees, same penalty.
- **Member M1:** Juan Dela Cruz, active. **Member M2:** pending app registration.
- **Staff:** ADM (Admin), MGR (Manager), LO (Loan Officer), CSH (Cashier), AUD (Auditor).

Priority: **C** = Critical (must pass for go-live), **H** = High, **M** = Medium.

### 12.1 Authentication and Access (AT-AUTH, AT-RBAC)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-AUTH-01 | C | Staff login | Log in as LO with correct credentials and a valid authenticator code | Dashboard opens; login recorded in audit trail with IP and time |
| AT-AUTH-02 | C | Wrong password lockout | Enter wrong password 5 times for CSH | Account locked for 15 minutes; message shown; ADM can unlock; events audited |
| AT-AUTH-03 | H | Session expiry | Leave admin idle past session timeout, then click any action | User is asked to log in again; no data is changed |
| AT-AUTH-04 | C | Deactivated staff | ADM deactivates LO; LO tries to log in or uses an existing session | Login refused; existing session rejected on next request |
| AT-AUTH-05 | H | Password policy | Set a new password "12345" | Rejected; minimum 8 characters with letters and numbers required |
| AT-AUTH-06 | C | Two-factor required | New staff account logs in for the first time; then a later login with correct password but wrong or reused code | First login forces 2FA setup (QR code, recovery codes shown once) before any screen opens; wrong or reused code refused and counted toward lockout; events audited |
| AT-AUTH-07 | H | 2FA recovery | CSH loses phone; logs in with a recovery code; ADM resets CSH's 2FA | Recovery code works once only; after reset CSH must set up 2FA again; reset audited |
| AT-RBAC-01 | C | Cashier limits | Log in as CSH; try to open Loan Products, approve a loan, or call the approve API directly | Menus hidden; direct API call returns 403; attempt audited |
| AT-RBAC-02 | C | Segregation of duties | LO encodes an application; LO (with an Approver role added for test) tries to approve the same application | Approval refused: "The encoder cannot approve this application" |
| AT-RBAC-03 | H | Auditor read-only | Log in as AUD; open members, loans, payments, audit trail; try to edit any record | All viewable; no edit/create/void actions available; API writes return 403 |
| AT-RBAC-04 | C | Member data isolation | Log in to the app as M1; request M2's loan by changing the ID in the API call | 404 returned; no data from another member is exposed |
| AT-RBAC-05 | C | Approver cannot release | MGR approves an application, then tries to release it in the UI and by calling the release API directly | Release refused: "The approver cannot release this loan"; ADM (or another Manager) can release it; attempt audited |

### 12.2 Members (AT-MEM)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-MEM-01 | C | Staff registers a member | LO fills required fields, uploads valid ID, saves | Member created as Active with a unique member number (e.g. M-2026-000001); audit entry created |
| AT-MEM-02 | C | Member self-registration | On the app, M2 fills personal info, uploads ID, accepts privacy consent, verifies OTP | Account created as Pending; M2 sees "Awaiting verification"; staff sees it in Pending Registrations |
| AT-MEM-03 | C | Approve app registration | LO reviews and approves M2 | M2 becomes Active; M2 receives a push notification and can now apply for loans |
| AT-MEM-04 | H | Duplicate check | Register another member with M1's mobile number, or same full name + birthdate | Mobile duplicate blocked; name+birthdate match shows a warning listing the possible duplicate |
| AT-MEM-05 | H | Required field validation | Save with missing birthdate, invalid mobile (e.g. 0917-12) or invalid email | Save blocked; each invalid field highlighted with a clear message |
| AT-MEM-06 | H | Profile change approval | M1 changes address in the app | Request shown as pending to staff; profile updated only after staff approval; both versions in audit |
| AT-MEM-07 | M | Search | Search by member number, partial last name, mobile | Correct members returned in under 2 seconds |
| AT-MEM-08 | H | Suspended member | MGR suspends M1; M1 tries to apply for a loan | Application blocked with message; existing loans and payments still viewable |
| AT-MEM-09 | H | Document privacy | Copy the URL of M1's ID image and open it after 10 minutes or in a logged-out browser | Access denied; links expire |

### 12.3 Loan Products and Computation (AT-PRD)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-PRD-01 | C | Diminishing schedule | Preview Product A, ₱50,000, 12 months | Monthly installment **₱4,727.98**. Installment 1: interest ₱1,000.00, principal ₱3,727.98, balance ₱46,272.02. Installment 2: interest ₱925.44, principal ₱3,802.54. Installment 12: interest ₱92.71, principal ₱4,635.27, balance **₱0.00**. Total interest **₱6,735.76**, total payable **₱56,735.76** |
| AT-PRD-02 | C | Add-on schedule | Preview Product B, ₱20,000, 6 months | Total interest **₱1,800.00**; installments 1–5 = ₱3,633.33 (principal ₱3,333.33 + interest ₱300.00); installment 6 = **₱3,633.35** (principal ₱3,333.35); total payable **₱21,800.00** |
| AT-PRD-03 | C | Match client sheet | Enter 3 real past loans from the client's records | Every installment, total interest and balance matches the client's sheet to the centavo |
| AT-PRD-04 | H | Product limits | Preview Product A for ₱250,000 or 30 months | Rejected with "Amount must be between ₱5,000 and ₱200,000" / "Term not allowed" |
| AT-PRD-05 | C | Product change does not affect existing loans | Release a loan on Product A; change Product A rate to 2.5% | Existing loan schedule unchanged; new previews use 2.5%; change audited |
| AT-PRD-06 | M | Deactivate product | MGR deactivates Product B | Not offered in app or admin for new applications; existing Product B loans unaffected |
| AT-PRD-07 | H | Month-end due dates | Release a monthly loan on January 31 | Due dates fall on Feb 28 (or 29), Mar 31, Apr 30, and so on |

### 12.4 Loan Applications (AT-APP)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-APP-01 | C | Apply from mobile | M1 chooses Product A, ₱50,000, 12 months, sees schedule preview, uploads payslip, submits | Application number shown; status Submitted; staff dashboard shows it live without refresh; LO notified |
| AT-APP-02 | C | Walk-in application | LO encodes an application for M1 in admin | Status Submitted, channel Walk-in; M1 sees it in the app |
| AT-APP-03 | C | Status tracking | LO marks Under Review; MGR approves with remarks | Each change appears in M1's app timeline with date and time; push notification sent for each |
| AT-APP-04 | C | Decline | MGR declines with reason "Incomplete requirements" | M1 sees Declined with reason; notified; cannot be released |
| AT-APP-05 | H | Member cancel | M1 cancels while Submitted; tries to cancel another that is Under Review | First succeeds; second blocked |
| AT-APP-06 | C | Eligibility: max active loans | M1 has an active Product A loan; applies for another Product A loan | Blocked: "Maximum active loans for this product reached" |
| AT-APP-07 | H | Required documents | Submit without a required document | Submission blocked; missing document named |

### 12.5 Loan Release (AT-REL)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-REL-01 | C | Release with fees | ADM releases the ₱50,000 Product A loan approved by MGR, on 2026-12-01 | Loan number generated; processing fee ₱1,000.00; net proceeds **₱49,000.00**; 12 installments due Jan 1 2027 to Dec 1 2027; ledger entries for principal ₱50,000.00, interest ₱6,735.76 and fee ₱1,000.00; status Active; release voucher printable; M1 notified |
| AT-REL-02 | C | Atomic release | Simulate a database failure in the middle of a release | Nothing saved: no loan, no installments, no ledger entries, application still Approved |
| AT-REL-03 | C | Double release prevention | Click Release twice quickly, or two managers release the same application | Exactly one loan created; second attempt refused |
| AT-REL-04 | C | Member sees loan | Open M1's app after release | Loan visible with balance ₱50,000.00 principal (₱56,735.76 total payable), next due Jan 1 2027 ₱4,727.98, 12 remaining installments |

### 12.6 Payments (AT-PAY)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-PAY-01 | C | Exact installment payment | CSH posts ₱4,727.98 cash, OR 000101, for installment 1 of the AT-REL-01 loan, on time | Allocation: interest ₱1,000.00, principal ₱3,727.98; installment 1 Paid; principal balance ₱46,272.02; receipt printable; M1's app updates within 10 seconds |
| AT-PAY-02 | C | Partial payment with penalty | Installment 1 unpaid; on day 10 after due (past 3-day grace), post ₱3,000.00 | Penalty assessed ₱141.84. Allocation: penalty ₱141.84, interest ₱1,000.00, principal ₱1,858.16. Installment 1 Partial with ₱1,869.82 principal remaining |
| AT-PAY-03 | C | Advance payment | Post ₱9,455.96 when only installment 1 is due | Installments 1 and 2 marked Paid; next due becomes installment 3 |
| AT-PAY-04 | C | Overpayment beyond balance | Post an amount greater than the total outstanding balance | Rejected with the exact payoff amount shown |
| AT-PAY-05 | C | Full payoff | Post the payoff amount shown on the loan | All installments Paid; loan Fully Paid; balances ₱0.00; M1 notified; fully paid notice printable |
| AT-PAY-06 | C | Duplicate OR number | Post a payment using OR 000101 again | Rejected: "OR number already used" |
| AT-PAY-07 | C | Double-click / retry | Click Post twice or resend the same request (same idempotency key) | Exactly one payment recorded |
| AT-PAY-08 | C | Concurrent posting | Two cashiers post to the same loan at the same moment | Both succeed in sequence, or one is asked to retry; final balances are correct; no double allocation |
| AT-PAY-09 | C | Void payment | MGR voids the AT-PAY-01 payment with reason "Wrong loan" | Payment status Voided (still visible, struck through); reversal ledger entries written, each pointing to the original entry; original entries unchanged; installment 1 back to Unpaid; balance restored to ₱50,000.00 principal; audit records who, when, why; M1 sees the correction |
| AT-PAY-10 | C | Cashier cannot void | CSH tries to void a payment | Not allowed (403) |
| AT-PAY-11 | H | Non-cash payment | Post via bank transfer with reference number | Method and reference saved and shown on receipt and reports |
| AT-PAY-12 | H | Payment history | M1 opens Payment History | All posted payments listed newest first with date, OR number, amount and allocation; voided payments marked |

### 12.7 Overdue and Monitoring (AT-OVD, AT-DSH)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-OVD-01 | C | Overdue status | Leave installment 1 unpaid; run the daily job for Jan 2, 2027 | Installment Overdue; loan Past Due; days past due = 1; no penalty yet (within grace) |
| AT-OVD-02 | C | Penalty after grace | Run the daily job for Jan 5 (day 4) | Penalty ₱141.84 assessed once |
| AT-OVD-03 | C | Idempotent job | Run the daily job twice for the same date | Penalty not duplicated; numbers unchanged |
| AT-OVD-04 | H | Second penalty period | Run for day 31 past due (still unpaid) | Second penalty period assessed per the rule (another ₱141.84) |
| AT-OVD-05 | C | Aging buckets | Seed loans 0, 15, 45, 75, 120 days past due | Each appears in the correct bucket (Current, 1–30, 31–60, 61–90, 90+) with correct totals |
| AT-OVD-06 | H | Penalty waiver | MGR waives ₱141.84 with reason | Penalty balance reduced; waiver in audit and Penalty report; LO cannot waive |
| AT-DSH-01 | C | Dashboard totals | Compare dashboard figures with a manual sum of seeded data | Outstanding portfolio, releases, collections, due today, overdue amount all match exactly |
| AT-DSH-02 | H | Live update | Keep dashboard open while CSH posts a payment on another computer | Collections today updates within 10 seconds without refreshing |
| AT-DSH-03 | H | Due today / overdue list | Open Due Today and Overdue lists | Correct members, amounts, contact numbers; exportable |

### 12.8 Notifications and Reminders (AT-NTF)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-NTF-01 | C | Before-due reminder | Installment due Jan 1; run reminder job Dec 29, 9:00 AM | M1 receives push: "Your payment of ₱4,727.98 is due on Jan 1, 2027"; stored in inbox |
| AT-NTF-02 | C | Due-date and overdue reminders | Run on Jan 1 and Jan 2 with installment unpaid | Due-today and overdue reminders sent; no reminder if already paid |
| AT-NTF-03 | H | No duplicates | Run the reminder job twice the same day | Only one reminder per installment per trigger |
| AT-NTF-04 | H | Quiet hours | Trigger reminders at 10:00 PM | Held until 8:00 AM |
| AT-NTF-05 | C | Event notifications | Approve, decline, release, post payment, void payment | M1 receives the matching notification for each event |
| AT-NTF-06 | M | Inbox read state | Open a notification | Marked read; unread badge decreases |
| AT-NTF-07 | M | Push disabled | M1 disables push in phone settings | Notifications still appear in the in-app inbox |

### 12.9 Mobile App Experience (AT-MOB)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-MOB-01 | C | Home summary | M1 opens app | Shows total outstanding, next due date and amount, overdue warning if any; values match admin |
| AT-MOB-02 | C | Loan detail | Open the loan | Shows principal, interest and penalty balances, paid vs remaining installments (e.g. "3 of 12 paid, 9 remaining"), full schedule with status per installment |
| AT-MOB-03 | H | Biometric unlock | Enable fingerprint/Face ID, close and reopen app | App unlocks with biometrics; falls back to password |
| AT-MOB-04 | H | Offline viewing | Turn off internet and open app | Last synced data shown with "Last updated" time; actions that need internet are disabled with a message |
| AT-MOB-05 | H | Devices | Run on a low-end Android 8 phone and an iPhone with iOS 15 | All screens usable; no crashes; text readable |
| AT-MOB-06 | C | Logout and token safety | Log out, then press back or reopen app | Login required; no member data visible |

### 12.10 Real-Time Synchronization (AT-SYNC)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-SYNC-01 | C | Admin → app | With M1's app open, CSH posts a payment | App balance and history update within 10 seconds |
| AT-SYNC-02 | C | App → admin | M1 submits an application | Appears in the admin Applications queue within 10 seconds with no refresh |
| AT-SYNC-03 | H | Reconnect | Disconnect M1's phone, post a payment, reconnect | App shows updated data within 10 seconds of reconnecting |

### 12.11 Reports (AT-RPT)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-RPT-01 | C | Collections report | Generate for a date range, by cashier | Totals equal the sum of posted (not voided) payments; per-cashier subtotals correct |
| AT-RPT-02 | C | Outstanding balances | Generate as of a date | Each loan's balance matches its loan detail; grand total matches dashboard |
| AT-RPT-03 | C | Aging report | Generate as of a date | Matches AT-OVD-05 results |
| AT-RPT-04 | H | Releases report | Generate for a month | Lists every loan released with principal, fees, net proceeds |
| AT-RPT-05 | C | Member ledger | Generate for M1 | Chronological releases, payments, penalties, waivers and voids with running balance that ends at the current balance |
| AT-RPT-06 | H | Export formats | Export each report to PDF and Excel | Files open correctly; Excel numbers are numeric (summable), not text; PDF has company header, date range, generated by and time |
| AT-RPT-07 | M | Large range | Generate a one-year collections report on seeded data | Completes in under 30 seconds |

### 12.12 Security, Audit, Ledger, Backup and Performance (AT-SEC, AT-AUD, AT-LED, AT-BKP, AT-PERF)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-SEC-01 | C | HTTPS only | Open admin over http:// | Redirected to https://; valid certificate |
| AT-SEC-02 | C | Passwords stored safely | Inspect the database | Passwords stored only as Argon2 hashes; TOTP secrets encrypted; recovery codes stored only as hashes |
| AT-SEC-03 | H | Injection and XSS | Enter `' OR '1'='1` and `admin'--` in login fields, and `<script>` in a name field | Login fails; no SQL error leaked; script shown as plain text, never executed |
| AT-SEC-04 | H | Vulnerability scan | Run OWASP ZAP baseline and dependency audit | No High or Critical findings open |
| AT-AUD-01 | C | Audit completeness | Perform create member, edit member, approve, release, post, void, waive, settings change, login | Each action has an audit entry with user, time, IP, before and after values |
| AT-AUD-02 | C | Audit tamper-proof | As ADM, try to edit or delete an audit entry via UI or API; attempt `UPDATE`/`DELETE` on `audit_logs` with the application database role | Not possible; the database refuses with a permission error |
| AT-AUD-03 | H | Audit chain check | With database owner access on staging, alter one audit entry; run the nightly integrity job | Job reports a broken hash chain at that entry and alerts Admin |
| AT-LED-01 | C | Ledger matches balances | After running AT-REL-01 through AT-PAY-09 and AT-OVD-01 to AT-OVD-06, run the nightly integrity job | For every loan and installment, the sum of ledger entries equals the stored principal, interest and penalty balances; job reports no mismatches |
| AT-LED-02 | C | Mismatch detected | With database owner access on staging, change a loan's stored principal balance by ₱0.01; run the integrity job | Mismatch reported with loan number and both amounts; Admin alerted; stored balance not changed automatically |
| AT-LED-03 | C | Ledger is append-only | Attempt `UPDATE`/`DELETE` on `ledger_entries` with the application database role, and try to reverse the same entry twice | Database refuses the edit and delete; second reversal refused by the unique constraint |
| AT-BKP-01 | C | Daily backup | Check backup storage after 2 days | Two encrypted backups present off-server with success logs; failure triggers an email alert |
| AT-BKP-02 | C | Restore drill | Restore the latest backup to a fresh staging server | System runs; record counts and balances match the source as of backup time; restore completed within 4 hours |
| AT-PERF-01 | H | Load | k6: 200 concurrent users on seeded 50,000 members / 80,000 loans | p95 under 500 ms; no errors |
| AT-PERF-02 | H | Daily job duration | Run the overdue job on seeded data | Completes in under 10 minutes |

### 12.13 Usability (AT-UX)

| ID | Pri | Test | Steps | Expected result |
|---|---|---|---|---|
| AT-UX-01 | H | Cashier speed | A trained cashier posts a payment from member search to printed receipt | Done in under 1 minute, within 3 screens |
| AT-UX-02 | H | First-time member | A member who has never used the app registers and finds their next due date without help | Completed without assistance |
| AT-UX-03 | M | Confirmations | Try release, void, waive, suspend | Each asks for confirmation with a summary of the effect |
| AT-UX-04 | M | Error messages | Trigger common errors | Messages are plain language and say what to do next |

---

## 13. UAT Procedure and Sign-off

1. Staging is loaded with test data (Section 12) plus a copy of 20 to 50 real anonymized loans provided by the client.
2. Client staff (at least one Manager, one Loan Officer, one Cashier) run the tests over Week 9, recording Pass/Fail and remarks.
3. Defects are logged with screenshots and fixed daily; failed tests are re-run after fixes.
4. **Go-live criteria:** all Critical (C) tests pass, no open Critical or High defects, restore drill passed, client signs the UAT acceptance form.

| Role | Name | Signature | Date |
|---|---|---|---|
| Client Representative | | | |
| Manager / Approver | | | |
| Developer | Jonah Pacas-Abanil, CpE | | |

---

## 14. Go-Live Checklist

- [ ] Production server hardened (firewall, SSH keys only, automatic security updates)
- [ ] PostgreSQL not publicly exposed; TLS required; separate migration (owner) and application roles with least-privilege grants; daily backup, WAL archiving and alert verified
- [ ] Environment secrets set; debug off; CORS restricted to the admin domain
- [ ] Domain and SSL active; uptime and error monitoring active
- [ ] Loan products, penalty rules, settings and OR series configured with real values
- [ ] Staff accounts created with correct roles; default passwords changed; every staff member has set up two-factor login
- [ ] Nightly integrity job running with alerts verified; first run on migrated data reports no ledger mismatches
- [ ] Existing members and loans migrated and balances reconciled with client records
- [ ] Android app published on Google Play; iOS app submitted/approved on App Store under the company's accounts
- [ ] Staff trained; user guides delivered (Admin, Cashier, Member)
- [ ] Source code, credentials and runbook handed over
- [ ] 60-day warranty period start date recorded