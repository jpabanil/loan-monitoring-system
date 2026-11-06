/**
 * Runs the daily overdue job and the integrity check once, by hand.
 *   pnpm job:daily                 # as of today (Asia/Manila)
 *   pnpm job:daily 2027-01-05      # as of a given date (testing AT-OVD)
 */
import { createDb } from "../src/db/client";
import { runDailyOverdue, runIntegrityCheck } from "../src/jobs/daily";
import { todayManila } from "../src/lib/time";

const asOf = process.argv[2] ?? todayManila();
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error("Usage: pnpm job:daily [YYYY-MM-DD]");
  process.exit(1);
}
const { db, pool } = createDb(process.env.DATABASE_URL!);
try {
  console.log(await runDailyOverdue(db, asOf));
  const integrity = await runIntegrityCheck(db);
  console.log({ integrityOk: integrity.ok, mismatches: integrity.balanceMismatches, auditChain: integrity.auditChain });
} finally {
  await pool.end();
}
