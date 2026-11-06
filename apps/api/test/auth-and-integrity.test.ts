import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIntegrityCheck } from "../src/jobs/daily";
import { currentStep, totpAt } from "../src/lib/totp";
import { TEST_APP_URL } from "./env";
import { as, createStaff, M1, makeApp, owner, PASSWORD, PRODUCT_A, resetDb, tokenFor, type TestStaff } from "./helpers";

let app: FastifyInstance;
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload: payload as object, headers }).then((r) => ({ status: r.statusCode, body: r.json(), cookies: r.cookies }));

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
  await owner.end();
});

describe("staff sign-in (AT-AUTH)", () => {
  it("forces two-factor setup on first sign-in, then signs in (AT-AUTH-06)", async () => {
    const s = await createStaff("loan_officer", { twoFactor: false });
    const login = await post("/auth/staff/login", { email: s.email, password: PASSWORD });
    expect(login.body.step).toBe("totp_setup");
    const setup = await post("/auth/staff/2fa/setup", { challengeToken: login.body.challengeToken });
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const confirm = await post("/auth/staff/2fa/confirm", { challengeToken: login.body.challengeToken, code: totpAt(setup.body.secret, currentStep()) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(8);
    expect(confirm.cookies.map((c) => c.name)).toEqual(expect.arrayContaining(["lms_at", "lms_rt"]));
    const { rows } = await owner.query("select 1 from audit_logs where action = 'login' and actor_id = $1", [s.id]);
    expect(rows.length).toBe(1);
  });

  it("refuses a two-factor code that was already used (AT-AUTH-06)", async () => {
    const s = await createStaff("cashier");
    const step = currentStep();
    const first = await post("/auth/staff/login", { email: s.email, password: PASSWORD });
    expect((await post("/auth/staff/2fa/verify", { challengeToken: first.body.challengeToken, code: totpAt(s.totpSecret, step) })).status).toBe(200);
    const second = await post("/auth/staff/login", { email: s.email, password: PASSWORD });
    const replay = await post("/auth/staff/2fa/verify", { challengeToken: second.body.challengeToken, code: totpAt(s.totpSecret, step) });
    expect(replay.status).toBe(401);
  });

  it("locks after 5 wrong passwords and an admin can unlock (AT-AUTH-02)", async () => {
    const s = await createStaff("cashier");
    const adm = await createStaff("admin");
    let last = { status: 0, body: {} as any };
    for (let i = 0; i < 5; i++) last = await post("/auth/staff/login", { email: s.email, password: "wrong-password-1" });
    expect(last.status).toBe(423);
    expect((await post("/auth/staff/login", { email: s.email, password: PASSWORD })).status).toBe(423);
    expect((await as(app, adm)("POST", `/staff-users/${s.id}/unlock`)).status).toBe(200);
    expect((await post("/auth/staff/login", { email: s.email, password: PASSWORD })).status).toBe(200);
    const { rows } = await owner.query("select action from audit_logs where entity_id = $1 order by id", [s.email]);
    expect(rows.map((r) => r.action)).toContain("auth.locked");
  });

  it("rejects an existing session once the account is deactivated (AT-AUTH-04)", async () => {
    const s = await createStaff("loan_officer");
    const adm = await createStaff("admin");
    expect((await as(app, s)("GET", "/members")).status).toBe(200);
    await as(app, adm)("PATCH", `/staff-users/${s.id}`, { status: "deactivated" });
    expect((await as(app, s)("GET", "/members")).status).toBe(401);
  });

  it("enforces the password policy (AT-AUTH-05)", async () => {
    const s = await createStaff("manager");
    const res = await as(app, s)("POST", "/auth/staff/change-password", { currentPassword: PASSWORD, newPassword: "12345" });
    expect(res.status).toBe(400);
  });

  it("does not reveal whether an email exists", async () => {
    const res = await post("/auth/staff/login", { email: "nobody@test.example", password: "x" });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Email or password is incorrect.");
  });

  it("rate-limits sign-in attempts per IP", async () => {
    const limited = await makeApp("2026-12-01", 3);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await limited.inject({ method: "POST", url: "/api/v1/auth/staff/login", payload: { email: "nobody@test.example", password: "x" } });
        codes.push(r.statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally {
      await limited.close();
    }
  });

  it("refuses a cross-site write made with the session cookie", async () => {
    const s = await createStaff("loan_officer");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/members",
      cookies: { lms_at: tokenFor(app, s) },
      headers: { origin: "https://evil.example" },
      payload: M1,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("append-only data (AT-AUD, AT-LED)", () => {
  let mgr: TestStaff;
  beforeAll(async () => {
    mgr = await createStaff("manager");
    await as(app, mgr)("POST", "/loan-products", PRODUCT_A);
  });

  it("the app's database role cannot change or delete ledger and audit rows (AT-AUD-02, AT-LED-03)", async () => {
    const appRole = new pg.Client({ connectionString: TEST_APP_URL });
    await appRole.connect();
    try {
      await expect(appRole.query("update audit_logs set summary = 'x'")).rejects.toThrow(/permission denied/);
      await expect(appRole.query("delete from audit_logs")).rejects.toThrow(/permission denied/);
      await expect(appRole.query("update ledger_entries set amount = 1")).rejects.toThrow(/permission denied/);
      await expect(appRole.query("truncate ledger_entries")).rejects.toThrow(/permission denied/);
      await expect(appRole.query("delete from payments")).rejects.toThrow(/permission denied/);
    } finally {
      await appRole.end();
    }
    expect((await as(app, mgr)("DELETE", "/audit-logs/1")).status).toBe(404);
  });

  it("detects a tampered audit entry (AT-AUD-03)", async () => {
    expect((await runIntegrityCheck(app.db)).auditChain.brokenAtId).toBeNull();
    const { rows } = await owner.query("select min(id)::int as id from audit_logs");
    await owner.query("update audit_logs set summary = 'edited' where id = $1", [rows[0].id]);
    expect((await runIntegrityCheck(app.db)).auditChain.brokenAtId).toBe(rows[0].id);
  });
});
