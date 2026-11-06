import { addDays, addMonths, dayOfMonth, type IsoDate } from "./dates";
import { Dec, roundCentavos, sumCentavos, type Centavos } from "./money";

/**
 * Amortization engine (plan.md 5.1). Server and clients share this file; the
 * API's result is the source of truth and clients use it for previews only.
 */
export type InterestMethod = "diminishing" | "add_on";
export type PaymentFrequency = "weekly" | "monthly";

export interface ScheduleInput {
  principal: Centavos;
  /** Rate per payment period as a decimal string, e.g. "0.02" for 2% per month. */
  ratePerPeriod: string;
  periods: number;
  method: InterestMethod;
  frequency: PaymentFrequency;
  releaseDate: IsoDate;
  /** Optional manual first due date set at release. */
  firstDueDate?: IsoDate;
}

export interface ScheduledInstallment {
  seq: number;
  dueDate: IsoDate;
  principal: Centavos;
  interest: Centavos;
  total: Centavos;
  /** Principal remaining after this installment is paid. */
  balance: Centavos;
}

export interface Schedule {
  installments: ScheduledInstallment[];
  installmentAmount: Centavos;
  totalInterest: Centavos;
  totalPayable: Centavos;
  maturityDate: IsoDate;
}

export function dueDates(input: Pick<ScheduleInput, "frequency" | "periods" | "releaseDate" | "firstDueDate">): IsoDate[] {
  const { frequency, periods, releaseDate, firstDueDate } = input;
  const dates: IsoDate[] = [];
  if (frequency === "monthly") {
    const first = firstDueDate ?? addMonths(releaseDate, 1);
    const anchor = dayOfMonth(firstDueDate ?? releaseDate);
    for (let k = 0; k < periods; k++) dates.push(addMonths(first, k, anchor));
  } else {
    const first = firstDueDate ?? addDays(releaseDate, 7);
    for (let k = 0; k < periods; k++) dates.push(addDays(first, 7 * k));
  }
  return dates;
}

export function buildSchedule(input: ScheduleInput): Schedule {
  const { principal, ratePerPeriod, periods, method } = input;
  if (!Number.isInteger(periods) || periods < 1) throw new RangeError("Term must be at least 1 period");
  if (principal <= 0) throw new RangeError("Principal must be positive");
  const r = new Dec(ratePerPeriod);
  if (r.isNegative()) throw new RangeError("Rate cannot be negative");

  const dates = dueDates(input);
  const installments: ScheduledInstallment[] = [];
  let balance = principal;

  if (method === "diminishing") {
    // A = P × r ÷ (1 − (1 + r)^−n); a zero rate is a straight split.
    const payment = r.isZero()
      ? roundCentavos(new Dec(principal).dividedBy(periods))
      : roundCentavos(new Dec(principal).times(r).dividedBy(new Dec(1).minus(r.plus(1).pow(-periods))));
    for (let seq = 1; seq <= periods; seq++) {
      const interest = roundCentavos(new Dec(balance).times(r));
      // The last installment absorbs rounding so principal ends at exactly ₱0.00.
      const principalPart = seq === periods ? balance : Math.min(payment - interest, balance);
      balance -= principalPart;
      installments.push({
        seq,
        dueDate: dates[seq - 1]!,
        principal: principalPart,
        interest,
        total: principalPart + interest,
        balance,
      });
    }
  } else {
    const totalInterest = roundCentavos(new Dec(principal).times(r).times(periods));
    const principalEach = roundCentavos(new Dec(principal).dividedBy(periods));
    const interestEach = roundCentavos(new Dec(totalInterest).dividedBy(periods));
    let interestLeft = totalInterest;
    for (let seq = 1; seq <= periods; seq++) {
      const last = seq === periods;
      const principalPart = last ? balance : principalEach;
      const interest = last ? interestLeft : interestEach;
      balance -= principalPart;
      interestLeft -= interest;
      installments.push({
        seq,
        dueDate: dates[seq - 1]!,
        principal: principalPart,
        interest,
        total: principalPart + interest,
        balance,
      });
    }
  }

  const totalInterest = sumCentavos(installments.map((i) => i.interest));
  return {
    installments,
    installmentAmount: installments[0]!.total,
    totalInterest,
    totalPayable: principal + totalInterest,
    maturityDate: installments[installments.length - 1]!.dueDate,
  };
}
