/**
 * Development seed: the plan's test data (plan.md section 12). Staff accounts
 * get a known development password and must set up two-factor on first sign-in.
 * Refuses to run in production.
 *
 *   pnpm db:seed
 */
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { loanProducts, members, staffUsers } from "../src/db/schema";
import { SYSTEM_ACTOR, writeAudit } from "../src/services/audit";

export const DEV_PASSWORD = "Password123!";

export const SEED_STAFF = [
  { code: "ADM", name: "Ricardo Lim", email: "admin@example.com", role: "admin" },
  { code: "MGR", name: "Maria Santos", email: "manager@example.com", role: "manager" },
  { code: "MGR2", name: "Elena Ramos", email: "manager2@example.com", role: "manager" },
  { code: "LO", name: "Jose Garcia", email: "officer@example.com", role: "loan_officer" },
  { code: "CSH", name: "Carmela Cruz", email: "cashier@example.com", role: "cashier" },
  { code: "AUD", name: "Dennis Yap", email: "auditor@example.com", role: "auditor" },
] as const;

export const SEED_PRODUCTS = [
  {
    code: "A", name: "Regular Loan", description: "Diminishing balance, for most member needs.", interestRate: "0.02", method: "diminishing", frequency: "monthly",
    termsAllowed: [6, 9, 12, 18, 24], minAmount: 500_000, maxAmount: 20_000_000, feeRate: "0.02", penaltyRate: "0.03", graceDays: 3, maxActiveLoans: 1,
  },
  {
    code: "B", name: "Quick Loan", description: "Small add-on loan, fast approval.", interestRate: "0.015", method: "add_on", frequency: "monthly",
    termsAllowed: [3, 4, 5, 6], minAmount: 100_000, maxAmount: 3_000_000, feeRate: "0", penaltyRate: "0.03", graceDays: 3, maxActiveLoans: 1,
  },
] as const;

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed a production database.");
  const { db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const passwordHash = await hash(DEV_PASSWORD);
    await db.transaction(async (tx) => {
      await tx
        .insert(staffUsers)
        .values(SEED_STAFF.map((s) => ({ name: s.name, email: s.email, role: s.role, passwordHash })))
        .onConflictDoNothing();
      await tx
        .insert(loanProducts)
        .values(SEED_PRODUCTS.map((p) => ({ ...p, termsAllowed: [...p.termsAllowed] })))
        .onConflictDoNothing();
      const m1 = await tx.execute<{ seq: string }>(sql`select nextval('member_no_seq')::text as seq`);
      const m2 = await tx.execute<{ seq: string }>(sql`select nextval('member_no_seq')::text as seq`);
      const year = new Date().getFullYear();
      await tx
        .insert(members)
        .values([
          {
            memberNo: `M-${year}-${m1.rows[0]!.seq.padStart(6, "0")}`, firstName: "Juan", lastName: "Dela Cruz", birthdate: "1985-04-12", sex: "M", civilStatus: "Married",
            address: "12 Mabini St., Quezon City", mobile: "09171234567", email: "juan.delacruz@example.com", employment: "Jeepney operator", govIdType: "PhilSys ID", status: "active", channel: "walk_in",
          },
          {
            memberNo: `M-${year}-${m2.rows[0]!.seq.padStart(6, "0")}`, firstName: "Andrea", lastName: "Gonzales", birthdate: "1998-10-10", sex: "F", civilStatus: "Single",
            address: "45 Rizal Ave., San Juan City", mobile: "09181234567", employment: "Online seller", govIdType: "UMID", status: "pending", channel: "mobile",
            consentVersion: "2026-01", consentAcceptedAt: new Date(),
          },
        ])
        .onConflictDoNothing();
      await writeAudit(tx, SYSTEM_ACTOR, { action: "seed", entity: "database", entityId: "dev", summary: "Loaded development seed data" });
    });
    console.log(`Seeded. Staff sign in with their email and "${DEV_PASSWORD}", then set up two-factor:`);
    for (const s of SEED_STAFF) console.log(`  ${s.code.padEnd(5)} ${s.email}`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
