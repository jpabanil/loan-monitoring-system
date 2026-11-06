import { describe, expect, it } from "vitest";
import {
  agingBucket,
  allocatePayment,
  buildSchedule,
  dueDates,
  PaymentExceedsBalanceError,
  penaltyPerPeriod,
  penaltyPeriods,
  pesosToCentavos,
  formatPeso,
} from "./index";

const penaltyRule = { rate: "0.03", graceDays: 3 };

describe("AT-PRD-01 diminishing schedule (Product A, ₱50,000, 12 months, 2%/month)", () => {
  const s = buildSchedule({
    principal: 5_000_000,
    ratePerPeriod: "0.02",
    periods: 12,
    method: "diminishing",
    frequency: "monthly",
    releaseDate: "2026-12-01",
  });

  it("has the expected installment and totals", () => {
    expect(s.installmentAmount).toBe(472_798);
    expect(s.totalInterest).toBe(673_576);
    expect(s.totalPayable).toBe(5_673_576);
  });

  it("matches installments 1, 2 and 12 to the centavo", () => {
    expect(s.installments[0]).toMatchObject({ interest: 100_000, principal: 372_798, balance: 4_627_202 });
    expect(s.installments[1]).toMatchObject({ interest: 92_544, principal: 380_254 });
    expect(s.installments[11]).toMatchObject({ interest: 9_271, principal: 463_527, balance: 0 });
  });

  it("is due Jan 1 2027 to Dec 1 2027 (AT-REL-01)", () => {
    expect(s.installments[0]!.dueDate).toBe("2027-01-01");
    expect(s.maturityDate).toBe("2027-12-01");
  });
});

describe("AT-PRD-02 add-on schedule (Product B, ₱20,000, 6 months, 1.5%/month)", () => {
  const s = buildSchedule({
    principal: 2_000_000,
    ratePerPeriod: "0.015",
    periods: 6,
    method: "add_on",
    frequency: "monthly",
    releaseDate: "2026-12-01",
  });

  it("matches the expected figures", () => {
    expect(s.totalInterest).toBe(180_000);
    for (const i of s.installments.slice(0, 5)) expect(i).toMatchObject({ principal: 333_333, interest: 30_000, total: 363_333 });
    expect(s.installments[5]).toMatchObject({ principal: 333_335, total: 363_335, balance: 0 });
    expect(s.totalPayable).toBe(2_180_000);
  });
});

describe("AT-PRD-07 month-end due dates", () => {
  it("clamps to the last day of shorter months", () => {
    expect(dueDates({ frequency: "monthly", periods: 4, releaseDate: "2027-01-31" })).toEqual([
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
    ]);
    expect(dueDates({ frequency: "monthly", periods: 1, releaseDate: "2028-01-31" })).toEqual(["2028-02-29"]);
  });
});

describe("property: principal always sums to the loan amount and ends at ₱0.00", () => {
  it("holds across many inputs", () => {
    for (const principal of [500_000, 1_234_567, 5_000_000, 20_000_000]) {
      for (const periods of [3, 6, 7, 12, 24]) {
        for (const method of ["diminishing", "add_on"] as const) {
          const s = buildSchedule({ principal, ratePerPeriod: "0.0175", periods, method, frequency: "monthly", releaseDate: "2026-01-15" });
          expect(s.installments.reduce((t, i) => t + i.principal, 0)).toBe(principal);
          expect(s.installments.at(-1)!.balance).toBe(0);
          for (const i of s.installments) expect(i.principal).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe("penalty (AT-OVD-01, 02, 04)", () => {
  it("waits for the grace period, then charges per 30-day period", () => {
    expect(penaltyPeriods("2027-01-01", "2027-01-02", penaltyRule)).toBe(0);
    expect(penaltyPeriods("2027-01-01", "2027-01-04", penaltyRule)).toBe(0);
    expect(penaltyPeriods("2027-01-01", "2027-01-05", penaltyRule)).toBe(1);
    expect(penaltyPeriods("2027-01-01", "2027-02-01", penaltyRule)).toBe(2);
    expect(penaltyPerPeriod(472_798, penaltyRule)).toBe(14_184);
  });
});

describe("allocation (AT-PAY-01, 02, 03, 04)", () => {
  const due = [
    { seq: 1, dueDate: "2027-01-01", penalty: 0, interest: 100_000, principal: 372_798 },
    { seq: 2, dueDate: "2027-02-01", penalty: 0, interest: 92_544, principal: 380_254 },
  ];

  it("pays an exact installment", () => {
    expect(allocatePayment(due, 472_798)).toEqual([{ seq: 1, penalty: 0, interest: 100_000, principal: 372_798 }]);
  });

  it("pays penalty, then interest, then principal", () => {
    const withPenalty = [{ ...due[0]!, penalty: 14_184 }, due[1]!];
    expect(allocatePayment(withPenalty, 300_000)).toEqual([{ seq: 1, penalty: 14_184, interest: 100_000, principal: 185_816 }]);
  });

  it("carries an advance into the next installment", () => {
    const lines = allocatePayment(due, 945_596);
    expect(lines.map((l) => l.seq)).toEqual([1, 2]);
    expect(lines[1]).toEqual({ seq: 2, penalty: 0, interest: 92_544, principal: 380_254 });
  });

  it("rejects more than the payoff and reports the payoff", () => {
    expect(() => allocatePayment(due, 945_597)).toThrow(PaymentExceedsBalanceError);
    try {
      allocatePayment(due, 945_597);
    } catch (e) {
      expect((e as PaymentExceedsBalanceError).payoff).toBe(945_596);
    }
  });
});

describe("helpers", () => {
  it("parses and formats pesos", () => {
    expect(pesosToCentavos("4,727.98")).toBe(472_798);
    expect(pesosToCentavos("₱50,000")).toBe(5_000_000);
    expect(() => pesosToCentavos("12.345")).toThrow();
    expect(formatPeso(472_798)).toBe("₱4,727.98");
  });

  it("buckets aging (AT-OVD-05)", () => {
    expect([0, 15, 45, 75, 120].map(agingBucket)).toEqual(["current", "1-30", "31-60", "61-90", "90+"]);
  });
});
