/**
 * THE LOAN LEDGER POSTING SERVICE (CLAUDE.md hard rules 1–3, plan.md 2.1 and 5.7).
 *
 * Every money movement — release, fee, penalty, waiver, payment, void — is
 * written here and nowhere else, in the caller's transaction, together with
 * the cached balances on loans/installments and the audit entry. Ledger rows
 * are never updated or deleted; a void writes reversing rows.
 *
 * Callers must pass a transaction (`Tx`) and must not catch-and-continue on
 * errors from these functions: any throw rolls the whole operation back.
 *
 * Second-reviewer area: changes here need a second reviewer (CLAUDE.md).
 */
import {
  allocatePayment,
  buildSchedule,
  daysBetween,
  Dec,
  formatPeso,
  PaymentExceedsBalanceError,
  penaltyPerPeriod,
  penaltyPeriods,
  roundCentavos,
  type Centavos,
  type InterestMethod,
  type IsoDate,
  type PaymentFrequency,
} from "@lms/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "../db/client";
import {
  applicationStatusHistory,
  installments,
  ledgerEntries,
  loanApplications,
  loanProducts,
  loans,
  members,
  notifications,
  paymentAllocations,
  payments,
  penaltyAssessments,
} from "../db/schema";
import { conflict, forbidden, notFound, pgConstraint, pgErrorCode, unprocessable } from "../lib/errors";
import { writeAudit, type Actor } from "./audit";

/** Terms frozen into each loan at release (plan.md 2.1 rule 4). */
export interface ProductSnapshot {
  productId: string;
  code: string;
  name: string;
  method: InterestMethod;
  interestRate: string;
  frequency: PaymentFrequency;
  feeRate: string;
  penaltyRate: string;
  graceDays: number;
}

type InstallmentRow = typeof installments.$inferSelect;
type LoanRow = typeof loans.$inferSelect;

function outstanding(i: InstallmentRow) {
  const principal = i.principalDue - i.principalPaid;
  const interest = i.interestDue - i.interestPaid;
  const penalty = i.penaltyDue - i.penaltyPaid - i.penaltyWaived;
  return { principal, interest, penalty, total: principal + interest + penalty };
}

function installmentStatus(i: InstallmentRow, asOf: IsoDate): InstallmentRow["status"] {
  const o = outstanding(i);
  if (o.total === 0) return "paid";
  if (i.dueDate < asOf) return "overdue";
  return i.principalPaid + i.interestPaid + i.penaltyPaid > 0 ? "partial" : "unpaid";
}

async function lockLoan(tx: Tx, loanId: string): Promise<LoanRow> {
  const [loan] = await tx.select().from(loans).where(eq(loans.id, loanId)).for("update");
  if (!loan) throw notFound("Loan");
  return loan;
}

async function loadInstallments(tx: Tx, loanId: string): Promise<InstallmentRow[]> {
  return tx.select().from(installments).where(eq(installments.loanId, loanId)).orderBy(asc(installments.seq));
}

/**
 * Recomputes the cached balances, statuses and days past due from the
 * installments, and bumps the loan's version (optimistic lock check on top of
 * the row lock the caller already holds).
 */
async function refreshLoan(tx: Tx, loan: LoanRow, rows: InstallmentRow[], asOf: IsoDate): Promise<LoanRow> {
  let principal = 0;
  let interest = 0;
  let penalty = 0;
  let oldestOpenDue: IsoDate | null = null;
  for (const i of rows) {
    const status = installmentStatus(i, asOf);
    if (status !== i.status) {
      await tx
        .update(installments)
        .set({ status, paidAt: status === "paid" ? (i.paidAt ?? new Date()) : null })
        .where(eq(installments.id, i.id));
    }
    const o = outstanding(i);
    principal += o.principal;
    interest += o.interest;
    penalty += o.penalty;
    if (o.total > 0 && oldestOpenDue === null) oldestOpenDue = i.dueDate;
  }
  const daysPastDue = oldestOpenDue && oldestOpenDue < asOf ? daysBetween(oldestOpenDue, asOf) : 0;
  const total = principal + interest + penalty;
  const status: LoanRow["status"] = total === 0 ? "fully_paid" : daysPastDue > 0 ? "past_due" : "active";
  const [updated] = await tx
    .update(loans)
    .set({
      principalBalance: principal,
      interestBalance: interest,
      penaltyBalance: penalty,
      daysPastDue,
      status,
      version: loan.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(loans.id, loan.id), eq(loans.version, loan.version)))
    .returning();
  if (!updated) throw conflict("CONCURRENT_UPDATE", "This loan was changed by someone else. Please try again.");
  return updated;
}

async function notify(tx: Tx, memberId: string, type: string, title: string, body: string, data: Record<string, unknown> = {}) {
  await tx.insert(notifications).values({ memberId, type, title, body, data, channels: ["inbox", "push"] });
}

function loanNo(seq: number, date: IsoDate) {
  return `L-${date.slice(0, 4)}-${String(seq).padStart(6, "0")}`;
}

// ---------------------------------------------------------------- release

export interface ReleaseInput {
  applicationId: string;
  releaseDate: IsoDate;
  firstDueDate?: IsoDate;
}

export async function releaseLoan(tx: Tx, actor: Actor, input: ReleaseInput) {
  const [app] = await tx.select().from(loanApplications).where(eq(loanApplications.id, input.applicationId)).for("update");
  if (!app) throw notFound("Application");
  if (app.status === "released") throw conflict("ALREADY_RELEASED", "This application has already been released.");
  if (app.status !== "approved") throw unprocessable("NOT_APPROVED", "Only approved applications can be released.");
  if (app.approvedBy && app.approvedBy === actor.id) {
    throw forbidden("The approver cannot release this loan. Another Manager or Admin must release it.");
  }

  const [member] = await tx.select().from(members).where(eq(members.id, app.memberId));
  if (!member || member.status !== "active") throw unprocessable("MEMBER_NOT_ACTIVE", "The member is not active.");
  const [product] = await tx.select().from(loanProducts).where(eq(loanProducts.id, app.productId));
  if (!product) throw notFound("Loan product");

  const snapshot: ProductSnapshot = {
    productId: product.id,
    code: product.code,
    name: product.name,
    method: product.method,
    interestRate: product.interestRate,
    frequency: product.frequency,
    feeRate: product.feeRate,
    penaltyRate: product.penaltyRate,
    graceDays: product.graceDays,
  };
  const schedule = buildSchedule({
    principal: app.amount,
    ratePerPeriod: snapshot.interestRate,
    periods: app.term,
    method: snapshot.method,
    frequency: snapshot.frequency,
    releaseDate: input.releaseDate,
    firstDueDate: input.firstDueDate,
  });
  const fee = roundCentavos(new Dec(app.amount).times(snapshot.feeRate));

  const seqRes = await tx.execute<{ seq: string }>(sql`select nextval('loan_no_seq')::text as seq`);
  const number = loanNo(Number(seqRes.rows[0]!.seq), input.releaseDate);

  let loan: LoanRow;
  try {
    [loan] = (await tx
      .insert(loans)
      .values({
        loanNo: number,
        applicationId: app.id,
        memberId: app.memberId,
        productId: product.id,
        productSnapshot: snapshot,
        principal: app.amount,
        totalInterest: schedule.totalInterest,
        feeAmount: fee,
        netProceeds: app.amount - fee,
        releaseDate: input.releaseDate,
        firstDueDate: schedule.installments[0]!.dueDate,
        maturityDate: schedule.maturityDate,
        principalBalance: app.amount,
        interestBalance: schedule.totalInterest,
        releasedBy: actor.id!,
      })
      .returning()) as [LoanRow];
  } catch (e) {
    if (pgErrorCode(e) === "23505" && pgConstraint(e) === "loans_application_uq") {
      throw conflict("ALREADY_RELEASED", "This application has already been released.");
    }
    throw e;
  }

  const rows = await tx
    .insert(installments)
    .values(
      schedule.installments.map((s) => ({
        loanId: loan.id,
        seq: s.seq,
        dueDate: s.dueDate,
        principalDue: s.principal,
        interestDue: s.interest,
      })),
    )
    .returning();

  const base = { loanId: loan.id, memberId: app.memberId, effectiveDate: input.releaseDate, postedBy: actor.name };
  const entries: (typeof ledgerEntries.$inferInsert)[] = [];
  for (const r of rows) {
    entries.push({ ...base, installmentId: r.id, entryType: "release", component: "principal", amount: r.principalDue });
    if (r.interestDue > 0) entries.push({ ...base, installmentId: r.id, entryType: "interest", component: "interest", amount: r.interestDue });
  }
  if (fee > 0) {
    entries.push({ ...base, entryType: "fee", component: "fee", amount: fee, memo: "Processing fee" });
    entries.push({ ...base, entryType: "payment", component: "fee", amount: -fee, memo: "Processing fee deducted from proceeds" });
  }
  await tx.insert(ledgerEntries).values(entries);

  await tx.update(loanApplications).set({ status: "released", updatedAt: new Date() }).where(eq(loanApplications.id, app.id));
  await tx.insert(applicationStatusHistory).values({ applicationId: app.id, status: "released", changedBy: actor.name });

  await writeAudit(tx, actor, {
    action: "loan.release",
    entity: "loan",
    entityId: number,
    summary: `Released ${product.name} ${formatPeso(app.amount)}; net proceeds ${formatPeso(app.amount - fee)}`,
    after: { applicationNo: app.applicationNo, principal: app.amount, fee, netProceeds: app.amount - fee, installments: rows.length },
  });
  await notify(tx, app.memberId, "loan.released", "Your loan has been released", `${product.name} ${formatPeso(app.amount)}. First payment of ${formatPeso(schedule.installmentAmount)} is due ${schedule.installments[0]!.dueDate}.`, {
    loanId: loan.id,
  });
  return loan;
}

// ---------------------------------------------------------------- payments

export interface PaymentInput {
  loanId: string;
  amount: Centavos;
  receiptNo: string;
  method: "cash" | "bank" | "e_wallet" | "check";
  referenceNo?: string;
  paymentDate: IsoDate;
}

export async function postPayment(tx: Tx, actor: Actor, input: PaymentInput) {
  const loan = await lockLoan(tx, input.loanId);
  if (loan.status === "fully_paid") throw unprocessable("LOAN_FULLY_PAID", "This loan is already fully paid.");
  if (input.method !== "cash" && !input.referenceNo) {
    throw unprocessable("REFERENCE_REQUIRED", "A reference number is required for non-cash payments.");
  }
  const rows = await loadInstallments(tx, loan.id);

  let lines;
  try {
    lines = allocatePayment(
      rows.map((r) => ({ seq: r.seq, dueDate: r.dueDate, ...outstanding(r) })),
      input.amount,
    );
  } catch (e) {
    if (e instanceof PaymentExceedsBalanceError) {
      throw unprocessable("EXCEEDS_BALANCE", `The payment is more than the total balance. The payoff amount is ${formatPeso(e.payoff)}.`, {
        payoff: e.payoff,
      });
    }
    throw e;
  }

  let payment: typeof payments.$inferSelect;
  try {
    const advance = lines
      .filter((l) => rows.find((r) => r.seq === l.seq)!.dueDate > input.paymentDate)
      .reduce((t, l) => t + l.penalty + l.interest + l.principal, 0);
    [payment] = (await tx
      .insert(payments)
      .values({
        receiptNo: input.receiptNo,
        loanId: loan.id,
        memberId: loan.memberId,
        amount: input.amount,
        method: input.method,
        referenceNo: input.referenceNo ?? null,
        paymentDate: input.paymentDate,
        advanceAmount: advance,
        receivedBy: actor.id!,
      })
      .returning()) as [typeof payments.$inferSelect];
  } catch (e) {
    if (pgErrorCode(e) === "23505" && pgConstraint(e) === "payments_receipt_uq") {
      throw conflict("OR_NUMBER_USED", "OR number already used.");
    }
    throw e;
  }

  const entries: (typeof ledgerEntries.$inferInsert)[] = [];
  const base = { loanId: loan.id, memberId: loan.memberId, paymentId: payment.id, entryType: "payment" as const, effectiveDate: input.paymentDate, postedBy: actor.name };
  for (const line of lines) {
    const inst = rows.find((r) => r.seq === line.seq)!;
    await tx.insert(paymentAllocations).values({ paymentId: payment.id, installmentId: inst.id, seq: line.seq, penalty: line.penalty, interest: line.interest, principal: line.principal });
    await tx
      .update(installments)
      .set({
        penaltyPaid: inst.penaltyPaid + line.penalty,
        interestPaid: inst.interestPaid + line.interest,
        principalPaid: inst.principalPaid + line.principal,
      })
      .where(eq(installments.id, inst.id));
    inst.penaltyPaid += line.penalty;
    inst.interestPaid += line.interest;
    inst.principalPaid += line.principal;
    if (line.penalty) entries.push({ ...base, installmentId: inst.id, component: "penalty", amount: -line.penalty });
    if (line.interest) entries.push({ ...base, installmentId: inst.id, component: "interest", amount: -line.interest });
    if (line.principal) entries.push({ ...base, installmentId: inst.id, component: "principal", amount: -line.principal });
  }
  await tx.insert(ledgerEntries).values(entries);
  const updated = await refreshLoan(tx, loan, rows, input.paymentDate);

  await writeAudit(tx, actor, {
    action: "payment.post",
    entity: "payment",
    entityId: input.receiptNo,
    summary: `Posted ${formatPeso(input.amount)} to ${loan.loanNo}`,
    after: { amount: input.amount, method: input.method, loanNo: loan.loanNo, allocation: lines },
  });
  await notify(tx, loan.memberId, "payment.posted", "Payment received", `We received ${formatPeso(input.amount)} for loan ${loan.loanNo}. OR ${input.receiptNo}.`, { paymentId: payment.id });
  if (updated.status === "fully_paid") {
    await notify(tx, loan.memberId, "loan.fully_paid", "Loan fully paid", `Congratulations! Loan ${loan.loanNo} is fully paid.`, { loanId: loan.id });
  }
  return { payment, allocation: lines, loan: updated };
}

export async function voidPayment(tx: Tx, actor: Actor, paymentId: string, reason: string, asOf: IsoDate) {
  const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
  if (!payment) throw notFound("Payment");
  if (payment.status === "voided") throw conflict("ALREADY_VOIDED", "This payment is already voided.");
  const loan = await lockLoan(tx, payment.loanId);

  const original = await tx
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.paymentId, payment.id), isNull(ledgerEntries.reversesEntryId)));
  await tx.insert(ledgerEntries).values(
    original.map((e) => ({
      loanId: e.loanId,
      memberId: e.memberId,
      installmentId: e.installmentId,
      entryType: "reversal" as const,
      component: e.component,
      amount: -e.amount,
      paymentId: payment.id,
      reversesEntryId: e.id,
      memo: `Void: ${reason}`,
      effectiveDate: asOf,
      postedBy: actor.name,
    })),
  );

  const allocations = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, payment.id));
  const rows = await loadInstallments(tx, loan.id);
  for (const a of allocations) {
    const inst = rows.find((r) => r.id === a.installmentId)!;
    inst.penaltyPaid -= a.penalty;
    inst.interestPaid -= a.interest;
    inst.principalPaid -= a.principal;
    await tx
      .update(installments)
      .set({ penaltyPaid: inst.penaltyPaid, interestPaid: inst.interestPaid, principalPaid: inst.principalPaid, paidAt: null })
      .where(eq(installments.id, inst.id));
    inst.paidAt = null;
  }
  await tx
    .update(payments)
    .set({ status: "voided", voidReason: reason, voidedBy: actor.id, voidedAt: new Date() })
    .where(eq(payments.id, payment.id));
  const updated = await refreshLoan(tx, loan, rows, asOf);

  await writeAudit(tx, actor, {
    action: "payment.void",
    entity: "payment",
    entityId: payment.receiptNo,
    summary: `Voided ${formatPeso(payment.amount)}: ${reason}`,
    before: { status: "posted" },
    after: { status: "voided", reason },
  });
  await notify(tx, payment.memberId, "payment.voided", "Payment corrected", `Payment OR ${payment.receiptNo} (${formatPeso(payment.amount)}) was voided: ${reason}.`, { paymentId: payment.id });
  return updated;
}

// ---------------------------------------------------------------- penalties

/**
 * Assesses penalties due on one loan as of a date (plan.md 5.4). Idempotent:
 * the unique (installment, period) index means a second run adds nothing.
 */
export async function assessLoanPenalties(tx: Tx, actor: Actor, loanId: string, asOf: IsoDate) {
  const loan = await lockLoan(tx, loanId);
  if (loan.status === "fully_paid" || loan.status === "written_off") return { loan, added: 0 };
  const snap = loan.productSnapshot as ProductSnapshot;
  const rule = { rate: snap.penaltyRate, graceDays: snap.graceDays };
  const rows = await loadInstallments(tx, loan.id);
  let added = 0;
  for (const inst of rows) {
    const o = outstanding(inst);
    if (o.principal + o.interest === 0 || inst.dueDate >= asOf) continue;
    const periods = penaltyPeriods(inst.dueDate, asOf, rule);
    for (let periodNo = 1; periodNo <= periods; periodNo++) {
      const amount = penaltyPerPeriod(o.principal + o.interest, rule);
      if (amount <= 0) continue;
      const [assessment] = await tx
        .insert(penaltyAssessments)
        .values({ installmentId: inst.id, loanId: loan.id, periodNo, amount, assessedForDate: asOf })
        .onConflictDoNothing()
        .returning();
      if (!assessment) continue;
      inst.penaltyDue += amount;
      added += amount;
      await tx.update(installments).set({ penaltyDue: inst.penaltyDue }).where(eq(installments.id, inst.id));
      await tx.insert(ledgerEntries).values({
        loanId: loan.id,
        memberId: loan.memberId,
        installmentId: inst.id,
        entryType: "penalty",
        component: "penalty",
        amount,
        penaltyAssessmentId: assessment.id,
        memo: `Penalty period ${periodNo}, installment ${inst.seq}`,
        effectiveDate: asOf,
        postedBy: actor.name,
      });
    }
  }
  const updated = await refreshLoan(tx, loan, rows, asOf);
  if (added > 0) {
    await writeAudit(tx, actor, {
      action: "penalty.assess",
      entity: "loan",
      entityId: loan.loanNo,
      summary: `Assessed ${formatPeso(added)} penalty as of ${asOf}`,
      after: { added, asOf },
    });
  }
  return { loan: updated, added };
}

export async function waivePenalty(tx: Tx, actor: Actor, loanId: string, reason: string, asOf: IsoDate) {
  const loan = await lockLoan(tx, loanId);
  const rows = await loadInstallments(tx, loan.id);
  let total = 0;
  const entries: (typeof ledgerEntries.$inferInsert)[] = [];
  for (const inst of rows) {
    const p = outstanding(inst).penalty;
    if (p <= 0) continue;
    inst.penaltyWaived += p;
    total += p;
    await tx.update(installments).set({ penaltyWaived: inst.penaltyWaived }).where(eq(installments.id, inst.id));
    entries.push({
      loanId: loan.id,
      memberId: loan.memberId,
      installmentId: inst.id,
      entryType: "penalty_waiver",
      component: "penalty",
      amount: -p,
      memo: `Waived: ${reason}`,
      effectiveDate: asOf,
      postedBy: actor.name,
    });
  }
  if (total === 0) throw unprocessable("NO_PENALTY", "This loan has no penalty to waive.");
  await tx.insert(ledgerEntries).values(entries);
  const updated = await refreshLoan(tx, loan, rows, asOf);
  await writeAudit(tx, actor, {
    action: "penalty.waive",
    entity: "loan",
    entityId: loan.loanNo,
    summary: `Waived ${formatPeso(total)} penalty: ${reason}`,
    before: { penaltyBalance: loan.penaltyBalance },
    after: { penaltyBalance: updated.penaltyBalance, reason },
  });
  return { loan: updated, waived: total };
}

// ---------------------------------------------------------------- integrity

export interface BalanceMismatch {
  loanId: string;
  loanNo: string;
  component: "principal" | "interest" | "penalty" | "fee";
  stored: Centavos;
  ledger: Centavos;
}

/**
 * Recomputes every loan's balances from ledger_entries and compares them with
 * the stored cache (plan.md 5.7). Never corrects anything; it only reports.
 */
export async function findBalanceMismatches(tx: DbOrTx, loanIds?: string[]): Promise<BalanceMismatch[]> {
  const sums = await tx
    .select({
      loanId: ledgerEntries.loanId,
      principal: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.component} = 'principal'), 0)`,
      interest: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.component} = 'interest'), 0)`,
      penalty: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.component} = 'penalty'), 0)`,
      fee: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.component} = 'fee'), 0)`,
    })
    .from(ledgerEntries)
    .where(loanIds ? inArray(ledgerEntries.loanId, loanIds) : undefined)
    .groupBy(ledgerEntries.loanId);
  const stored = await tx
    .select({ id: loans.id, loanNo: loans.loanNo, principal: loans.principalBalance, interest: loans.interestBalance, penalty: loans.penaltyBalance })
    .from(loans)
    .where(loanIds ? inArray(loans.id, loanIds) : undefined);

  const out: BalanceMismatch[] = [];
  for (const l of stored) {
    const s = sums.find((x) => x.loanId === l.id);
    const ledger = { principal: Number(s?.principal ?? 0), interest: Number(s?.interest ?? 0), penalty: Number(s?.penalty ?? 0), fee: Number(s?.fee ?? 0) };
    for (const component of ["principal", "interest", "penalty"] as const) {
      if (ledger[component] !== l[component]) out.push({ loanId: l.id, loanNo: l.loanNo, component, stored: l[component], ledger: ledger[component] });
    }
    if (ledger.fee !== 0) out.push({ loanId: l.id, loanNo: l.loanNo, component: "fee", stored: 0, ledger: ledger.fee });
  }
  return out;
}

