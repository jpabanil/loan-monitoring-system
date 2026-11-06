/**
 * The plan's lending acceptance tests, end to end through the HTTP API and a
 * real PostgreSQL: application → approval → release → payments → overdue.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDailyOverdue, runIntegrityCheck } from "../src/jobs/daily";
import { as, createStaff, M1, makeApp, owner, PRODUCT_A, PRODUCT_B, resetDb, type TestStaff } from "./helpers";

let app: FastifyInstance;
let adm: TestStaff, mgr: TestStaff, lo: TestStaff, csh: TestStaff, aud: TestStaff;
let productA: string, productB: string, m1: string, applicationId: string, loanId: string;
let firstPaymentId: string;

beforeAll(async () => {
  await resetDb();
  app = await makeApp("2026-12-01");
  [adm, mgr, lo, csh, aud] = await Promise.all([
    createStaff("admin"),
    createStaff("manager", { name: "Maria Santos" }),
    createStaff("loan_officer", { name: "Jose Garcia" }),
    createStaff("cashier"),
    createStaff("auditor"),
  ]);
  productA = (await as(app, adm)("POST", "/loan-products", PRODUCT_A)).body.id;
  productB = (await as(app, adm)("POST", "/loan-products", PRODUCT_B)).body.id;
  m1 = (await as(app, lo)("POST", "/members", M1)).body.id;
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe("members (AT-MEM)", () => {
  it("blocks a duplicate mobile and warns on same name + birthdate (AT-MEM-04)", async () => {
    const dupMobile = await as(app, lo)("POST", "/members", { ...M1, firstName: "Pedro", birthdate: "1990-01-01" });
    expect(dupMobile.status).toBe(409);
    expect(dupMobile.body.error.code).toBe("MOBILE_TAKEN");
    const dupName = await as(app, lo)("POST", "/members", { ...M1, mobile: "09179999999" });
    expect(dupName.body.error.code).toBe("POSSIBLE_DUPLICATE");
  });

  it("rejects an invalid mobile (AT-MEM-05)", async () => {
    const res = await as(app, lo)("POST", "/members", { ...M1, mobile: "0917-12" });
    expect(res.status).toBe(400);
  });

  it("gives the member a unique member number (AT-MEM-01)", async () => {
    const res = await as(app, aud)("GET", `/members/${m1}`);
    expect(res.body.memberNo).toMatch(/^M-\d{4}-000001$/);
    expect(res.body.status).toBe("active");
  });
});

describe("products (AT-PRD)", () => {
  it("previews the diminishing schedule to the centavo (AT-PRD-01)", async () => {
    const res = await as(app, lo)("POST", `/loan-products/${productA}/preview-schedule`, { amount: 5_000_000, term: 12 });
    expect(res.body.installmentAmount).toBe(472_798);
    expect(res.body.totalInterest).toBe(673_576);
    expect(res.body.installments[11]).toMatchObject({ interest: 9_271, principal: 463_527, balance: 0 });
  });

  it("enforces product limits (AT-PRD-04)", async () => {
    const res = await as(app, lo)("POST", `/loan-products/${productA}/preview-schedule`, { amount: 25_000_000, term: 12 });
    expect(res.body.error.message).toBe("Amount must be between ₱5,000.00 and ₱200,000.00.");
    const term = await as(app, lo)("POST", `/loan-products/${productA}/preview-schedule`, { amount: 5_000_000, term: 30 });
    expect(term.body.error.code).toBe("TERM_NOT_ALLOWED");
  });
});

describe("application and approval (AT-APP, AT-RBAC)", () => {
  it("LO encodes a walk-in application", async () => {
    const res = await as(app, lo)("POST", "/loan-applications", { memberId: m1, productId: productA, amount: 5_000_000, term: 12, purpose: "House repair" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "submitted", channel: "walk_in" });
    applicationId = res.body.id;
  });

  it("blocks a second open application on the same product (AT-APP-06)", async () => {
    const res = await as(app, lo)("POST", "/loan-applications", { memberId: m1, productId: productA, amount: 1_000_000, term: 6, purpose: "Second" });
    expect(res.body.error.message).toBe("Maximum active loans for this product reached.");
  });

  it("refuses a cashier and audits the attempt (AT-RBAC-01)", async () => {
    const res = await as(app, csh)("POST", `/loan-applications/${applicationId}/approve`, {});
    expect(res.status).toBe(403);
    const { rows } = await owner.query("select 1 from audit_logs where action = 'rbac.denied' and actor_id = $1", [csh.id]);
    expect(rows.length).toBe(1);
  });

  it("checks permission before validating the body", async () => {
    expect((await as(app, csh)("POST", "/loan-products", {})).status).toBe(403);
  });

  it("refuses the auditor any write (AT-RBAC-03)", async () => {
    expect((await as(app, aud)("POST", "/members", { ...M1, mobile: "09170000001" })).status).toBe(403);
    expect((await as(app, aud)("GET", "/loan-applications")).status).toBe(200);
  });

  it("does not let the encoder approve (AT-RBAC-02)", async () => {
    // Give the encoder an approver role for this check, as the plan's test does.
    await owner.query("update staff_users set role = 'manager' where id = $1", [lo.id]);
    const res = await as(app, { ...lo, role: "manager" })("POST", `/loan-applications/${applicationId}/approve`, {});
    await owner.query("update staff_users set role = 'loan_officer' where id = $1", [lo.id]);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("The encoder cannot approve this application.");
  });

  it("moves through review and approval with history (AT-APP-03)", async () => {
    expect((await as(app, lo)("POST", `/loan-applications/${applicationId}/review`, {})).body.status).toBe("under_review");
    expect((await as(app, mgr)("POST", `/loan-applications/${applicationId}/approve`, { remarks: "Good history" })).body.status).toBe("approved");
    const detail = await as(app, lo)("GET", `/loan-applications/${applicationId}`);
    expect(detail.body.history.map((h: { status: string }) => h.status)).toEqual(["submitted", "under_review", "approved"]);
  });
});

describe("release (AT-REL)", () => {
  it("does not let the approver release (AT-RBAC-05)", async () => {
    const res = await as(app, mgr)("POST", `/loan-applications/${applicationId}/release`, {});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/approver cannot release/);
  });

  it("releases with fees, schedule and ledger entries (AT-REL-01)", async () => {
    const res = await as(app, adm)("POST", `/loan-applications/${applicationId}/release`, { releaseDate: "2026-12-01" }, { "idempotency-key": "rel-1" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ feeAmount: 100_000, netProceeds: 4_900_000, firstDueDate: "2027-01-01", maturityDate: "2027-12-01", status: "active" });
    loanId = res.body.id;
    const ledger = await owner.query("select component, sum(amount)::bigint as total from ledger_entries where loan_id = $1 group by component order by component", [loanId]);
    expect(Object.fromEntries(ledger.rows.map((r) => [r.component, Number(r.total)]))).toEqual({ principal: 5_000_000, interest: 673_576, fee: 0 });
  });

  it("creates exactly one loan on a retry or a second release (AT-REL-03)", async () => {
    const replay = await as(app, adm)("POST", `/loan-applications/${applicationId}/release`, { releaseDate: "2026-12-01" }, { "idempotency-key": "rel-1" });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(loanId);
    const other = await createStaff("manager");
    const again = await as(app, other)("POST", `/loan-applications/${applicationId}/release`, {});
    expect(again.status).toBe(409);
    const { rows } = await owner.query("select count(*)::int as n from loans where application_id = $1", [applicationId]);
    expect(rows[0].n).toBe(1);
  });
});

describe("payments (AT-PAY)", () => {
  const pay = (amount: number, receiptNo: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    as(app, csh)("POST", "/payments", { loanId, amount, receiptNo, method: "cash", ...extra }, headers);

  it("posts an exact installment (AT-PAY-01)", async () => {
    app.config.FIXED_DATE = "2027-01-01";
    const res = await pay(472_798, "000101");
    expect(res.status).toBe(201);
    expect(res.body.allocation).toEqual([{ seq: 1, penalty: 0, interest: 100_000, principal: 372_798 }]);
    expect(res.body.loan.principalBalance).toBe(4_627_202);
    firstPaymentId = res.body.payment.id;
  });

  it("rejects a used OR number (AT-PAY-06)", async () => {
    const res = await pay(100_00, "000101");
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("OR number already used.");
  });

  it("rejects more than the payoff and shows the payoff (AT-PAY-04)", async () => {
    const loan = await as(app, csh)("GET", `/loans/${loanId}`);
    const res = await pay(loan.body.totalBalance + 1, "000102");
    expect(res.status).toBe(422);
    expect(res.body.error.details.payoff).toBe(loan.body.totalBalance);
  });

  it("records one payment for a double-click retry (AT-PAY-07)", async () => {
    const a = await pay(10_000, "000103", {}, { "idempotency-key": "dbl-1" });
    const b = await pay(10_000, "000103", {}, { "idempotency-key": "dbl-1" });
    expect(a.status).toBe(201);
    expect(b.body.payment.id).toBe(a.body.payment.id);
    const { rows } = await owner.query("select count(*)::int as n from payments where receipt_no = '000103'");
    expect(rows[0].n).toBe(1);
  });

  it("handles two cashiers posting at once (AT-PAY-08)", async () => {
    const before = (await as(app, csh)("GET", `/loans/${loanId}`)).body.totalBalance;
    const csh2 = await createStaff("cashier");
    const [x, y] = await Promise.all([pay(5_000, "000104"), as(app, csh2)("POST", "/payments", { loanId, amount: 7_000, receiptNo: "000105", method: "cash" })]);
    expect([x.status, y.status]).toEqual([201, 201]);
    const after = (await as(app, csh)("GET", `/loans/${loanId}`)).body.totalBalance;
    expect(after).toBe(before - 12_000);
  });

  it("does not let a cashier void (AT-PAY-10)", async () => {
    const res = await as(app, csh)("POST", `/payments/${firstPaymentId}/void`, { reason: "Wrong loan" });
    expect(res.status).toBe(403);
  });

  it("voids with reversing entries and restores the balance (AT-PAY-09)", async () => {
    const res = await as(app, mgr)("POST", `/payments/${firstPaymentId}/void`, { reason: "Wrong loan" });
    expect(res.status).toBe(200);
    const { rows } = await owner.query("select count(*)::int as n from ledger_entries where payment_id = $1 and entry_type = 'reversal'", [firstPaymentId]);
    expect(rows[0].n).toBe(2);
    const p = await as(app, aud)("GET", `/payments/${firstPaymentId}`);
    expect(p.body.status).toBe("voided");
    const again = await as(app, mgr)("POST", `/payments/${firstPaymentId}/void`, { reason: "Wrong loan" });
    expect(again.status).toBe(409);
  });

  it("requires a reference for non-cash payments (AT-PAY-11)", async () => {
    const res = await pay(10_000, "000106", { method: "bank" });
    expect(res.body.error.code).toBe("REFERENCE_REQUIRED");
  });
});

describe("overdue and penalties (AT-OVD)", () => {
  let loan2: string;

  beforeAll(async () => {
    // A fresh Product B loan, so the A-loan payments above do not affect the figures.
    const m = (await as(app, lo)("POST", "/members", { ...M1, firstName: "Ana", lastName: "Bautista", mobile: "09175550000", birthdate: "1990-09-03" })).body.id;
    const a = (await as(app, lo)("POST", "/loan-applications", { memberId: m, productId: productB, amount: 2_000_000, term: 6, purpose: "Stock" })).body.id;
    await as(app, mgr)("POST", `/loan-applications/${a}/approve`, {});
    loan2 = (await as(app, adm)("POST", `/loan-applications/${a}/release`, { releaseDate: "2026-12-01" })).body.id;
  });

  const loan = async () => (await as(app, aud)("GET", `/loans/${loan2}`)).body;

  it("marks overdue the day after, with no penalty inside grace (AT-OVD-01)", async () => {
    await runDailyOverdue(app.db, "2027-01-02");
    const l = await loan();
    expect(l).toMatchObject({ status: "past_due", daysPastDue: 1, penaltyBalance: 0 });
    expect(l.schedule[0].status).toBe("overdue");
  });

  it("assesses one penalty after grace, idempotently (AT-OVD-02, 03)", async () => {
    await runDailyOverdue(app.db, "2027-01-05");
    await runDailyOverdue(app.db, "2027-01-05");
    // 3% of the unpaid ₱3,633.33 installment.
    expect((await loan()).penaltyBalance).toBe(10_900);
  });

  it("assesses the second period on day 31 (AT-OVD-04)", async () => {
    await runDailyOverdue(app.db, "2027-01-31");
    expect((await loan()).penaltyBalance).toBe(10_900);
    await runDailyOverdue(app.db, "2027-02-01");
    expect((await loan()).penaltyBalance).toBe(21_800);
  });

  it("pays penalty, then interest, then principal (AT-PAY-02 rule)", async () => {
    app.config.FIXED_DATE = "2027-02-01";
    const res = await as(app, csh)("POST", "/payments", { loanId: loan2, amount: 100_000, receiptNo: "000201", method: "cash" });
    expect(res.body.allocation).toEqual([{ seq: 1, penalty: 21_800, interest: 30_000, principal: 48_200 }]);
  });

  it("lets only a manager waive, with a reason (AT-OVD-06)", async () => {
    await runDailyOverdue(app.db, "2027-02-06");
    expect((await as(app, lo)("POST", `/loans/${loan2}/waive-penalty`, { reason: "Hospitalized" })).status).toBe(403);
    const res = await as(app, mgr)("POST", `/loans/${loan2}/waive-penalty`, { reason: "Hospitalized" });
    expect(res.status).toBe(200);
    expect(res.body.loan.penaltyBalance).toBe(0);
  });

  it("keeps the ledger equal to the stored balances (AT-LED-01)", async () => {
    const result = await runIntegrityCheck(app.db);
    expect(result.balanceMismatches).toEqual([]);
    expect(result.auditChain.brokenAtId).toBeNull();
  });

  it("reports a stored balance that no longer matches the ledger (AT-LED-02)", async () => {
    await owner.query("update loans set principal_balance = principal_balance + 1 where id = $1", [loan2]);
    const result = await runIntegrityCheck(app.db);
    expect(result.balanceMismatches).toEqual([expect.objectContaining({ loanId: loan2, component: "principal" })]);
    const m = result.balanceMismatches[0]!;
    expect(m.stored - m.ledger).toBe(1);
    await owner.query("update loans set principal_balance = principal_balance - 1 where id = $1", [loan2]);
  });
});

describe("dashboard (AT-DSH-01)", () => {
  it("matches a direct sum of the data", async () => {
    app.config.FIXED_DATE = "2027-02-06";
    const res = await as(app, csh)("GET", "/dashboard/summary");
    const { rows } = await owner.query("select coalesce(sum(total_balance), 0)::bigint as t from loans where status in ('active', 'past_due')");
    expect(res.body.portfolioOutstanding).toBe(Number(rows[0].t));
  });

  it("sums collections by month, voids excluded", async () => {
    const res = await as(app, csh)("GET", "/dashboard/collections?months=3");
    expect(res.body.map((m: { month: string }) => m.month)).toEqual(["2026-12", "2027-01", "2027-02"]);
    const { rows } = await owner.query("select coalesce(sum(amount), 0)::bigint as t from payments where status = 'posted' and payment_date between '2027-01-01' and '2027-01-31'");
    expect(res.body[1].amount).toBe(Number(rows[0].t));
  });

  it("lists loans with next due and overdue amounts", async () => {
    const res = await as(app, csh)("GET", "/loans?status=past_due");
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0]).toEqual(expect.objectContaining({ productName: expect.any(String), overdueAmount: expect.any(Number), nextDueDate: expect.any(String) }));
  });

  it("counts applications by status and names the approver", async () => {
    const counts = await as(app, lo)("GET", "/loan-applications/counts");
    expect(counts.body.released).toBe(2);
    const detail = await as(app, lo)("GET", `/loan-applications/${applicationId}`);
    expect(detail.body).toMatchObject({ approvedByName: "Maria Santos", encodedByName: "Jose Garcia", product: { code: "A" } });
  });
});
