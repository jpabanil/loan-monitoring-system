import type { Role } from "@lms/shared";
import { hash } from "@node-rs/argon2";
import type { FastifyInstance, InjectOptions } from "fastify";
import pg from "pg";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { encryptSecret } from "../src/lib/crypto";
import { generateTotpSecret } from "../src/lib/totp";
import { TEST_APP_URL, TEST_OWNER_URL } from "./env";

export const KEY = Buffer.alloc(32, 7).toString("base64");
export const PASSWORD = "Correct1horse";

export async function makeApp(fixedDate = "2026-12-01", authRateLimit = 1000): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_APP_URL,
    JWT_SECRET: "test-secret-0123456789-0123456789-abcdef",
    DATA_ENCRYPTION_KEY: KEY,
    CORS_ORIGIN: "http://localhost:3000",
    FIXED_DATE: fixedDate,
    AUTH_RATE_LIMIT: String(authRateLimit),
  });
  const app = await buildApp(config);
  await app.ready();
  return app;
}

/** Owner connection, for resetting data and for the "someone with DB access tampers" tests. */
export const owner = new pg.Pool({ connectionString: TEST_OWNER_URL, max: 2 });

export async function resetDb() {
  const { rows } = await owner.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'");
  await owner.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  for (const s of ["member_no_seq", "application_no_seq", "loan_no_seq"]) await owner.query(`ALTER SEQUENCE ${s} RESTART`);
}

export interface TestStaff {
  id: string;
  name: string;
  email: string;
  role: Role;
  totpSecret: string;
}

let n = 0;
export async function createStaff(role: Role, opts: { twoFactor?: boolean; name?: string } = {}): Promise<TestStaff> {
  n += 1;
  const totpSecret = generateTotpSecret();
  const name = opts.name ?? `${role} ${n}`;
  const email = `${role}${n}@test.example`;
  const { rows } = await owner.query<{ id: string }>(
    `insert into staff_users (name, email, password_hash, role, totp_secret, totp_enabled_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [name, email, await hash(PASSWORD), role, opts.twoFactor === false ? null : encryptSecret(totpSecret, KEY), opts.twoFactor === false ? null : new Date()],
  );
  return { id: rows[0]!.id, name, email, role, totpSecret };
}

export function tokenFor(app: FastifyInstance, s: TestStaff) {
  return app.jwt.sign({ sub: s.id, typ: "staff", role: s.role });
}

/** Small client: `call(app, staff)("POST", "/api/v1/...", body, headers)`. */
export function as(app: FastifyInstance, s: TestStaff) {
  const token = tokenFor(app, s);
  return async (method: InjectOptions["method"], url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, payload: payload as InjectOptions["payload"], headers: { authorization: `Bearer ${token}`, ...headers } });
    let body: any;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
}

export const PRODUCT_A = {
  code: "A", name: "Regular Loan", interestRate: "0.02", method: "diminishing", frequency: "monthly", termsAllowed: [6, 9, 12, 18, 24],
  minAmount: 500_000, maxAmount: 20_000_000, feeRate: "0.02", penaltyRate: "0.03", graceDays: 3, maxActiveLoans: 1,
};
export const PRODUCT_B = {
  code: "B", name: "Quick Loan", interestRate: "0.015", method: "add_on", frequency: "monthly", termsAllowed: [3, 4, 5, 6],
  minAmount: 100_000, maxAmount: 3_000_000, feeRate: "0", penaltyRate: "0.03", graceDays: 3, maxActiveLoans: 1,
};
export const M1 = {
  firstName: "Juan", lastName: "Dela Cruz", birthdate: "1985-04-12", sex: "M", civilStatus: "Married",
  address: "12 Mabini St., Quezon City", mobile: "09171234567", employment: "Jeepney operator", govIdType: "PhilSys ID",
};
