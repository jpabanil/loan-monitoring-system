import { daysBetween, type IsoDate } from "./dates";
import { Dec, roundCentavos, type Centavos } from "./money";

/** What is still owed on one installment, by component. */
export interface InstallmentBalance {
  seq: number;
  dueDate: IsoDate;
  penalty: Centavos;
  interest: Centavos;
  principal: Centavos;
}

export interface AllocationLine {
  seq: number;
  penalty: Centavos;
  interest: Centavos;
  principal: Centavos;
}

export class PaymentExceedsBalanceError extends Error {
  constructor(readonly payoff: Centavos) {
    super("Payment is greater than the total outstanding balance");
    this.name = "PaymentExceedsBalanceError";
  }
}

export function outstandingTotal(installments: readonly InstallmentBalance[]): Centavos {
  return installments.reduce((t, i) => t + i.penalty + i.interest + i.principal, 0);
}

/**
 * Payment allocation (plan.md 5.3): oldest installment first, and within each
 * installment penalty → interest → principal. Money beyond what is due today
 * flows into the next installments as an advance. A payment above the payoff
 * amount is rejected with the payoff.
 */
export function allocatePayment(installments: readonly InstallmentBalance[], amount: Centavos): AllocationLine[] {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError("Payment must be a positive centavo amount");
  const payoff = outstandingTotal(installments);
  if (amount > payoff) throw new PaymentExceedsBalanceError(payoff);

  let left = amount;
  const lines: AllocationLine[] = [];
  for (const inst of [...installments].sort((a, b) => a.seq - b.seq)) {
    if (left === 0) break;
    const penalty = Math.min(left, inst.penalty);
    left -= penalty;
    const interest = Math.min(left, inst.interest);
    left -= interest;
    const principal = Math.min(left, inst.principal);
    left -= principal;
    if (penalty + interest + principal > 0) lines.push({ seq: inst.seq, penalty, interest, principal });
  }
  return lines;
}

export interface PenaltyRule {
  /** Penalty rate per 30-day period, decimal string ("0.03"). */
  rate: string;
  graceDays: number;
}

/**
 * Penalty (plan.md 5.4): rate × unpaid installment amount (principal + interest)
 * for each 30-day period, or part of one, past due — but only once the grace
 * period has passed. Returns the number of periods assessable and the amount per period.
 */
export function penaltyPeriods(dueDate: IsoDate, asOf: IsoDate, rule: PenaltyRule): number {
  const daysPastDue = daysBetween(dueDate, asOf);
  if (daysPastDue <= rule.graceDays) return 0;
  return Math.ceil(daysPastDue / 30);
}

export function penaltyPerPeriod(unpaidPrincipalAndInterest: Centavos, rule: PenaltyRule): Centavos {
  return roundCentavos(new Dec(unpaidPrincipalAndInterest).times(rule.rate));
}

export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export function agingBucket(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}
