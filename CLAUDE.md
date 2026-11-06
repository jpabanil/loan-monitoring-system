# CLAUDE.md: loan-monitoring-system

Loan Monitoring System for a lending company: a **member mobile app** (members see their loans, balances, schedules and payments, and apply for loans) and a **staff admin system** on the web (loan officers, managers, cashiers, auditors and admins run the loan lifecycle).

## Stack

- Language: TypeScript (strict) everywhere; Node.js 22 LTS; pnpm workspaces monorepo
- API: Fastify 5, Zod schemas via `fastify-type-provider-zod`, OpenAPI via `@fastify/swagger`
- Database: PostgreSQL 17; Drizzle ORM + `node-postgres`; migrations with `drizzle-kit`
- Staff admin: React/Next.js (App Router, web, desktop-first). UI only: all business logic and data access go through the Fastify API
- Member app: React Native (Expo)
- Background jobs: pg-boss, queue stored in PostgreSQL (schedule generation, reminders, penalty runs, reports)
- Real-time: `@fastify/websocket` for the admin; PostgreSQL `LISTEN/NOTIFY` to fan events out across API instances; push notifications for mobile
- Files (ID photos, income documents, signed forms): private S3 bucket, short-lived signed links only
- Repo layout: `apps/api/`, `apps/admin-web/`, `apps/member-app/`, `packages/shared/` (Zod schemas, API types, money helpers), `infra/`, `docs/`
- The full design is in `plan.md`. If this file and the plan disagree, ask.

## Hard rules (never break these)

1. **All money moves through the loan ledger service.** Disbursements, payments, interest, penalties, fees, waivers, write-offs and reversals are written only by that service, in one transaction with the loan balance update and the audit record. No other code writes ledger entries.
2. **The ledger is append-only.** Never edit or delete a ledger entry. Correct mistakes with a reversing entry that points to the original. The app's database role has no `UPDATE`, `DELETE` or `TRUNCATE` privilege on `ledger_entries` or `audit_logs`.
3. **Balances are computed from the ledger**, not typed in. Stored balances are a cache that the nightly integrity job recomputes and compares; any mismatch raises an alert.
4. **Money is integer centavos (`BIGINT`) in the database and `decimal.js` in code, never a JavaScript float.** Currency is stored with every amount. Rounding (ROUND_HALF_UP to the centavo) follows one documented rule, in one function in `packages/shared`. Money columns have `CHECK` constraints against invalid negatives.
5. **Interest, penalty and fee rules are configuration, not code.** Loan products define the method (for example flat, diminishing balance, add-on), rate, term options, grace period, penalty rule and payment allocation order (for example penalty, then interest, then principal). Every loan stores the product version it was approved under; later product edits never change existing loans.
6. **The repayment schedule is generated once, at disbursement, and is immutable.** Restructuring, extension or early settlement creates a new schedule version linked to the old one.
7. **Transactions:** one outer `db.transaction(async (tx) => …)` per operation. Every query inside it uses `tx`, never the global `db` (a query on `db` runs outside the transaction and is not rolled back). Lock the loan row with `SELECT … FOR UPDATE` before posting against it, and check the loan's `version` column on update. No external calls (push, S3, email) inside a transaction; queue them after commit.
8. **Four-eyes control.** The staff member who encodes a loan application cannot approve it; the approver cannot release it (another Manager or Admin releases); a cashier can never waive a penalty or void a payment. Enforce in the service layer, not only in the UI.
9. **Members see only their own records.** The member ID comes from the authenticated session, never from the URL, request body or app. Staff access is limited by role and, where used, by branch.
10. **Never build SQL from user input.** Parameterized queries only: use Drizzle's query builder or the `sql` tagged template, never `sql.raw()` or string concatenation with request data. Every request is validated by a Zod schema that strips unknown keys. No direct `pg` client use outside the data-access layer (CI fails the build).
11. **Nothing is final without the right approval.** Applications, approvals, disbursements, waivers, write-offs and restructures each have a recorded actor, time and reason.
12. **Soft delete only** for members, loans and documents. Records tied to money are never removed.

## Roles

The full permission matrix is in `plan.md` section 3.

| Role | Can do | Cannot do |
|---|---|---|
| Member (mobile) | View own loans, schedule, balance, payment history; apply and cancel while Submitted; upload documents; get notifications; request profile changes | See other members; change loan terms; record payments |
| Loan officer | Register members, approve app registrations, encode and review applications, upload KYC | Approve or release loans; post or void payments |
| Manager | Everything a loan officer can; configure products and settings; approve or decline applications; release loans; post and void payments; waive penalties | Approve an application they encoded; release a loan they approved |
| Cashier | Post payments, print receipts, collections reports | Void payments; waive penalties; approve or release loans; configure products |
| Auditor | Read-only access to members, loans, payments, reports and the audit trail; reconciliation | Create, edit, post or void anything |
| Admin | Staff users and roles, everything a manager can | Bypass four-eyes rules; write ledger entries outside the posting service |

Every role change and permission check is logged. Staff accounts require TOTP two-factor login (authenticator app, encrypted secret, one-time recovery codes; Admin can reset).

## Loan lifecycle (status flow)

Application: `submitted` -> `under_review` -> `approved` or `declined` -> `released`; a member can move it to `cancelled` only while `submitted`.

Loan (created at release, funds out, schedule created): `active` <-> `past_due` -> `fully_paid`, or `restructured`, `written_off`. Payments allocate in the product's configured order (default penalty, then interest, then principal, oldest installment first). Overdue status, days past due and penalties are computed from the schedule and ledger by the daily job, never set by hand.

Declines, waivers, voids, restructures and write-offs all require a reason.

## Data and schema

- Every row has a required `member_id` or `loan_id` foreign key where relevant, `created_at` / `updated_at` (`TIMESTAMPTZ`, UTC) and the acting user. Indexes start with the scoping column.
- Core tables (full list and columns in `plan.md` section 4): staff_users, members, member_accounts, documents, loan_products, loan_applications, loans (with product_snapshot), installments (with schedule_version), ledger_entries, penalty_assessments, payments, payment_allocations, idempotency_keys, notifications, audit_logs, settings.
- Constraints on every table: `NOT NULL` on required columns, foreign keys, `CHECK` on money and status values, `UNIQUE` where duplicates would be a bug (OR number, one loan per application, one penalty per installment per period, one reminder per installment per trigger).
- Sensitive fields (government ID numbers, birth date, contact details, bank / wallet account numbers) are encrypted at the application layer (envelope encryption with keys in a cloud key management service) before they reach PostgreSQL. Mask them in the UI and in exports unless the role needs them.
- Tables, constraints, indexes, roles and grants are created only by versioned `drizzle-kit` migrations, run by a separate migration (owner) role, never by the app role.

## Notifications and collections

- Reminders (before due, on due, overdue) are queued jobs with message templates; every message sent is logged.
- Use approved templates only; never put full balances or ID numbers in SMS or push text.
- Respect quiet hours and member contact preferences. Collection notes are factual and logged; no harassing or threatening wording in any template.

## Mobile app rules

- Login with PIN or biometrics on top of the member's account; short session lifetime; tokens in secure device storage.
- Read-mostly. The app never calculates balances or interest; it displays what the backend returns.
- No personal data in logs, crash reports or analytics. No secrets in the app bundle.
- Works on low-end Android phones and slow connections; show cached data with a clear "last updated" time.

## Security and operations

- No public database port or SSH. Admin access only through the cloud provider's session manager.
- Secrets in the secrets manager, never in code, git or logs.
- Do not log names, ID numbers, phone numbers, addresses, amounts tied to a person, or tokens. Audit log entries are insert-only and hash-chained.
- Backups: nightly full backup plus point-in-time recovery, copied to a second region; restore tested monthly.
- Releases: tagged, approved by the technical lead, backup first, one server at a time.

## Testing and CI

Every pull request must pass: lint, type check, unit tests (Vitest, fast-check property tests for money logic) and integration tests against a real PostgreSQL container (Testcontainers), the member-isolation suite, the no-raw-query check, and dependency and container scans.

Always test: interest and penalty calculations for each product method (against hand-computed examples signed off by the client's accountant), payment allocation order, partial and early payments, overpayment, void with reversal entries, ledger sum equals stored balances, restructure, schedule version change, four-eyes violations, member A trying to read member B, and a failure halfway through posting (everything rolls back).

## Open decisions (ask before building these parts)

- Country and regulator: legal and reporting requirements, currency, language, tax and data-protection rules depend on it.
- Interest method(s), penalty rules and fee types the company actually uses.
- Payment channels: cash, bank, e-wallet; whether payments are matched automatically or recorded by cashiers only.
- Whether members can pay in the app or only view (online payments are out of scope for version 1 in `plan.md`).
- Branch structure, collector field work, and credit scoring or credit bureau checks, if any.
- Identity verification (ID check, selfie) provider, and SMS provider.
- Hosting region and budget.

## Working conventions

- Build in this order: users and roles, members and KYC, loan products, applications and approvals, ledger and release, schedules and payments, overdue and penalties, member app, notifications, reports.
- Stay inside the agreed scope; anything extra is a change request.
- Money, ledger, role and member-isolation changes need a second reviewer. Add a TSDoc comment to anything touching them.
- When a rule here conflicts with a request, stop and ask instead of working around it.
- No hard-coded user-facing text; use the translation system.