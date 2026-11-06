/**
 * Database schema (plan.md section 4). Money columns are BIGINT centavos with
 * CHECK constraints. Grants, triggers and the append-only rules for
 * ledger_entries and audit_logs live in the hand-written migration
 * `0001_roles_and_rules.sql`.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const money = (name: string) => bigint(name, { mode: "number" });
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const staffRole = pgEnum("staff_role", ["admin", "manager", "loan_officer", "cashier", "auditor"]);
export const staffStatus = pgEnum("staff_status", ["active", "deactivated"]);
export const memberStatus = pgEnum("member_status", ["pending", "active", "suspended", "closed"]);
export const channel = pgEnum("channel", ["mobile", "walk_in"]);
export const interestMethod = pgEnum("interest_method", ["diminishing", "add_on"]);
export const frequency = pgEnum("payment_frequency", ["weekly", "monthly"]);
export const applicationStatus = pgEnum("application_status", ["submitted", "under_review", "approved", "declined", "cancelled", "released"]);
export const loanStatus = pgEnum("loan_status", ["active", "past_due", "fully_paid", "restructured", "written_off"]);
export const installmentStatus = pgEnum("installment_status", ["unpaid", "partial", "paid", "overdue"]);
export const paymentMethod = pgEnum("payment_method", ["cash", "bank", "e_wallet", "check"]);
export const paymentStatus = pgEnum("payment_status", ["posted", "voided"]);
export const ledgerEntryType = pgEnum("ledger_entry_type", ["release", "fee", "interest", "penalty", "penalty_waiver", "payment", "reversal"]);
export const ledgerComponent = pgEnum("ledger_component", ["principal", "interest", "penalty", "fee"]);

export const memberNoSeq = pgSequence("member_no_seq");
export const applicationNoSeq = pgSequence("application_no_seq");
export const loanNoSeq = pgSequence("loan_no_seq");

export const staffUsers = pgTable(
  "staff_users",
  {
    id: id(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: staffRole("role").notNull(),
    status: staffStatus("status").notNull().default("active"),
    /** AES-256-GCM ciphertext of the TOTP secret (see lib/crypto.ts). */
    totpSecret: text("totp_secret"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    /** Last accepted TOTP time step, so a code cannot be used twice. */
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    recoveryCodeHashes: text("recovery_code_hashes").array().notNull().default(sql`'{}'::text[]`),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("staff_users_email_uq").on(sql`lower(${t.email})`)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: id(),
    userType: text("user_type").notNull(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    familyId: uuid("family_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("refresh_tokens_hash_uq").on(t.tokenHash), index("refresh_tokens_user_idx").on(t.userType, t.userId)],
);

export const members = pgTable(
  "members",
  {
    id: id(),
    memberNo: text("member_no").notNull(),
    firstName: text("first_name").notNull(),
    middleName: text("middle_name"),
    lastName: text("last_name").notNull(),
    birthdate: date("birthdate", { mode: "string" }).notNull(),
    sex: text("sex").notNull(),
    civilStatus: text("civil_status").notNull(),
    address: text("address").notNull(),
    mobile: text("mobile").notNull(),
    email: text("email"),
    employment: text("employment").notNull(),
    govIdType: text("gov_id_type").notNull(),
    govIdNumber: text("gov_id_number"),
    govIdFileKey: text("gov_id_file_key"),
    photoKey: text("photo_key"),
    status: memberStatus("status").notNull().default("pending"),
    channel: channel("channel").notNull(),
    consentVersion: text("consent_version"),
    consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("members_member_no_uq").on(t.memberNo),
    uniqueIndex("members_mobile_uq").on(t.mobile),
    index("members_status_idx").on(t.status),
    index("members_name_trgm_idx").using("gin", sql`(${t.firstName} || ' ' || ${t.lastName}) gin_trgm_ops`),
    check("members_sex_chk", sql`${t.sex} in ('F', 'M')`),
    check("members_mobile_chk", sql`${t.mobile} ~ '^09[0-9]{9}$'`),
  ],
);

export const loanProducts = pgTable(
  "loan_products",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    interestRate: numeric("interest_rate", { precision: 9, scale: 6 }).notNull(),
    method: interestMethod("method").notNull(),
    frequency: frequency("frequency").notNull(),
    termsAllowed: integer("terms_allowed").array().notNull(),
    minAmount: money("min_amount").notNull(),
    maxAmount: money("max_amount").notNull(),
    /** Processing fee rate deducted from proceeds, e.g. 0.02. */
    feeRate: numeric("fee_rate", { precision: 9, scale: 6 }).notNull().default("0"),
    penaltyRate: numeric("penalty_rate", { precision: 9, scale: 6 }).notNull(),
    graceDays: integer("grace_days").notNull(),
    maxActiveLoans: integer("max_active_loans").notNull().default(1),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("loan_products_code_uq").on(t.code),
    check("loan_products_amounts_chk", sql`${t.minAmount} > 0 and ${t.minAmount} <= ${t.maxAmount}`),
    check("loan_products_rates_chk", sql`${t.interestRate} >= 0 and ${t.feeRate} >= 0 and ${t.penaltyRate} >= 0`),
  ],
);

export const loanApplications = pgTable(
  "loan_applications",
  {
    id: id(),
    applicationNo: text("application_no").notNull(),
    memberId: uuid("member_id").notNull().references(() => members.id),
    productId: uuid("product_id").notNull().references(() => loanProducts.id),
    amount: money("amount").notNull(),
    term: integer("term").notNull(),
    purpose: text("purpose").notNull(),
    channel: channel("channel").notNull(),
    status: applicationStatus("status").notNull().default("submitted"),
    encodedBy: uuid("encoded_by").references(() => staffUsers.id),
    approvedBy: uuid("approved_by").references(() => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("loan_applications_no_uq").on(t.applicationNo),
    index("loan_applications_member_status_idx").on(t.memberId, t.status),
    check("loan_applications_amount_chk", sql`${t.amount} > 0 and ${t.term} > 0`),
  ],
);

export const applicationStatusHistory = pgTable(
  "application_status_history",
  {
    id: id(),
    applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
    status: applicationStatus("status").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    remarks: text("remarks"),
  },
  (t) => [index("application_status_history_app_idx").on(t.applicationId, t.changedAt)],
);

export const loans = pgTable(
  "loans",
  {
    id: id(),
    loanNo: text("loan_no").notNull(),
    applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
    memberId: uuid("member_id").notNull().references(() => members.id),
    productId: uuid("product_id").notNull().references(() => loanProducts.id),
    productSnapshot: jsonb("product_snapshot").notNull(),
    principal: money("principal").notNull(),
    totalInterest: money("total_interest").notNull(),
    feeAmount: money("fee_amount").notNull(),
    netProceeds: money("net_proceeds").notNull(),
    releaseDate: date("release_date", { mode: "string" }).notNull(),
    firstDueDate: date("first_due_date", { mode: "string" }).notNull(),
    maturityDate: date("maturity_date", { mode: "string" }).notNull(),
    status: loanStatus("status").notNull().default("active"),
    principalBalance: money("principal_balance").notNull(),
    interestBalance: money("interest_balance").notNull(),
    penaltyBalance: money("penalty_balance").notNull().default(0),
    totalBalance: money("total_balance").generatedAlwaysAs(sql`principal_balance + interest_balance + penalty_balance`),
    daysPastDue: integer("days_past_due").notNull().default(0),
    releasedBy: uuid("released_by").notNull().references(() => staffUsers.id),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("loans_loan_no_uq").on(t.loanNo),
    uniqueIndex("loans_application_uq").on(t.applicationId),
    index("loans_member_status_idx").on(t.memberId, t.status),
    index("loans_status_idx").on(t.status),
    check("loans_balances_chk", sql`${t.principalBalance} >= 0 and ${t.interestBalance} >= 0 and ${t.penaltyBalance} >= 0`),
    check("loans_amounts_chk", sql`${t.principal} > 0 and ${t.netProceeds} >= 0 and ${t.feeAmount} >= 0`),
  ],
);

export const installments = pgTable(
  "installments",
  {
    id: id(),
    loanId: uuid("loan_id").notNull().references(() => loans.id),
    scheduleVersion: integer("schedule_version").notNull().default(1),
    seq: integer("seq").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    principalDue: money("principal_due").notNull(),
    interestDue: money("interest_due").notNull(),
    penaltyDue: money("penalty_due").notNull().default(0),
    principalPaid: money("principal_paid").notNull().default(0),
    interestPaid: money("interest_paid").notNull().default(0),
    penaltyPaid: money("penalty_paid").notNull().default(0),
    penaltyWaived: money("penalty_waived").notNull().default(0),
    status: installmentStatus("status").notNull().default("unpaid"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("installments_loan_seq_uq").on(t.loanId, t.scheduleVersion, t.seq),
    index("installments_due_status_idx").on(t.dueDate, t.status),
    check(
      "installments_paid_chk",
      sql`${t.principalPaid} between 0 and ${t.principalDue}
        and ${t.interestPaid} between 0 and ${t.interestDue}
        and ${t.penaltyPaid} >= 0 and ${t.penaltyWaived} >= 0
        and ${t.penaltyPaid} + ${t.penaltyWaived} <= ${t.penaltyDue}`,
    ),
  ],
);

export const penaltyAssessments = pgTable(
  "penalty_assessments",
  {
    id: id(),
    installmentId: uuid("installment_id").notNull().references(() => installments.id),
    loanId: uuid("loan_id").notNull().references(() => loans.id),
    periodNo: integer("period_no").notNull(),
    amount: money("amount").notNull(),
    assessedForDate: date("assessed_for_date", { mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Makes the daily job idempotent: one penalty per installment per 30-day period.
    uniqueIndex("penalty_assessments_period_uq").on(t.installmentId, t.periodNo),
    check("penalty_assessments_amount_chk", sql`${t.amount} > 0`),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    receiptNo: text("receipt_no").notNull(),
    loanId: uuid("loan_id").notNull().references(() => loans.id),
    memberId: uuid("member_id").notNull().references(() => members.id),
    amount: money("amount").notNull(),
    method: paymentMethod("method").notNull(),
    referenceNo: text("reference_no"),
    paymentDate: date("payment_date", { mode: "string" }).notNull(),
    advanceAmount: money("advance_amount").notNull().default(0),
    receivedBy: uuid("received_by").notNull().references(() => staffUsers.id),
    status: paymentStatus("status").notNull().default("posted"),
    voidReason: text("void_reason"),
    voidedBy: uuid("voided_by").references(() => staffUsers.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("payments_receipt_uq").on(t.receiptNo),
    index("payments_loan_date_idx").on(t.loanId, t.paymentDate),
    index("payments_date_idx").on(t.paymentDate),
    check("payments_amount_chk", sql`${t.amount} > 0`),
    check("payments_void_chk", sql`(${t.status} = 'voided') = (${t.voidReason} is not null)`),
  ],
);

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: id(),
    paymentId: uuid("payment_id").notNull().references(() => payments.id),
    installmentId: uuid("installment_id").notNull().references(() => installments.id),
    seq: integer("seq").notNull(),
    penalty: money("penalty").notNull(),
    interest: money("interest").notNull(),
    principal: money("principal").notNull(),
  },
  (t) => [
    index("payment_allocations_payment_idx").on(t.paymentId),
    index("payment_allocations_installment_idx").on(t.installmentId),
    check("payment_allocations_chk", sql`${t.penalty} >= 0 and ${t.interest} >= 0 and ${t.principal} >= 0`),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    loanId: uuid("loan_id").notNull().references(() => loans.id),
    memberId: uuid("member_id").notNull().references(() => members.id),
    installmentId: uuid("installment_id").references(() => installments.id),
    entryType: ledgerEntryType("entry_type").notNull(),
    component: ledgerComponent("component").notNull(),
    /** Signed centavos: + increases what the member owes, − reduces it. */
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("PHP"),
    paymentId: uuid("payment_id").references(() => payments.id),
    penaltyAssessmentId: uuid("penalty_assessment_id").references(() => penaltyAssessments.id),
    reversesEntryId: uuid("reverses_entry_id"),
    memo: text("memo"),
    effectiveDate: date("effective_date", { mode: "string" }).notNull(),
    postedBy: text("posted_by").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_entries_loan_idx").on(t.loanId, t.postedAt),
    index("ledger_entries_member_idx").on(t.memberId, t.effectiveDate),
    index("ledger_entries_installment_idx").on(t.installmentId),
    uniqueIndex("ledger_entries_reverses_uq").on(t.reversesEntryId),
    check("ledger_entries_amount_chk", sql`${t.amount} <> 0`),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: id(),
    actorId: uuid("actor_id").notNull(),
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code"),
    response: jsonb("response"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("idempotency_keys_actor_key_uq").on(t.actorId, t.key)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    memberId: uuid("member_id").notNull().references(() => members.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").notNull().default({}),
    channels: text("channels").array().notNull().default(sql`'{inbox}'::text[]`),
    installmentId: uuid("installment_id").references(() => installments.id),
    trigger: text("trigger"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_member_idx").on(t.memberId, t.createdAt),
    uniqueIndex("notifications_reminder_uq").on(t.installmentId, t.trigger).where(sql`${t.installmentId} is not null`),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    summary: text("summary").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [index("audit_logs_entity_idx").on(t.entity, t.entityId), index("audit_logs_at_idx").on(t.at), index("audit_logs_actor_idx").on(t.actorId)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});
