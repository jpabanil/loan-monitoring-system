import type { IsoDate } from "@lms/shared";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { loans } from "../db/schema";
import { SYSTEM_ACTOR, verifyAuditChain } from "../services/audit";
import { assessLoanPenalties, findBalanceMismatches, type BalanceMismatch } from "../services/posting";

export interface DailyResult {
  asOf: IsoDate;
  loansChecked: number;
  penaltyAdded: number;
  failures: { loanId: string; error: string }[];
}

/**
 * Daily overdue run (plan.md 5.4), scheduled for 00:30 Asia/Manila. Updates
 * statuses, days past due and penalties. Each loan is its own transaction, so
 * one bad loan never blocks the rest; re-running for the same date adds nothing.
 */
export async function runDailyOverdue(db: Db, asOf: IsoDate): Promise<DailyResult> {
  const open = await db.select({ id: loans.id }).from(loans).where(inArray(loans.status, ["active", "past_due"]));
  const result: DailyResult = { asOf, loansChecked: 0, penaltyAdded: 0, failures: [] };
  for (const { id } of open) {
    try {
      const { added } = await db.transaction((tx) => assessLoanPenalties(tx, SYSTEM_ACTOR, id, asOf));
      result.penaltyAdded += added;
      result.loansChecked += 1;
    } catch (e) {
      result.failures.push({ loanId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

export interface IntegrityResult {
  balanceMismatches: BalanceMismatch[];
  auditChain: { brokenAtId: number | null; checked: number };
  ok: boolean;
}

/**
 * Nightly integrity check (plan.md 5.7): balances recomputed from the ledger
 * and the audit hash chain. Reports only; never corrects anything.
 */
export async function runIntegrityCheck(db: Db): Promise<IntegrityResult> {
  const balanceMismatches = await findBalanceMismatches(db);
  const auditChain = await verifyAuditChain(db);
  return { balanceMismatches, auditChain, ok: balanceMismatches.length === 0 && auditChain.brokenAtId === null };
}
