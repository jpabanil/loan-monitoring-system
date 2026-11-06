/**
 * Background worker: schedules and runs the nightly jobs with pg-boss.
 * Job work uses the app role (DATABASE_URL). The queue itself uses
 * JOBS_DATABASE_URL, a role allowed to create pg-boss's own schema.
 */
import { PgBoss } from "pg-boss";
import { loadConfig } from "./config";
import { createDb } from "./db/client";
import { runDailyOverdue, runIntegrityCheck } from "./jobs/daily";
import { todayManila } from "./lib/time";

const DAILY = "daily-overdue";
const INTEGRITY = "nightly-integrity";

async function main() {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  const boss = new PgBoss(process.env.JOBS_DATABASE_URL ?? config.DATABASE_URL);
  boss.on("error", (e: unknown) => console.error("[pg-boss]", e));
  await boss.start();

  for (const name of [DAILY, INTEGRITY]) await boss.createQueue(name);
  await boss.schedule(DAILY, "30 0 * * *", {}, { tz: "Asia/Manila" });
  await boss.schedule(INTEGRITY, "0 1 * * *", {}, { tz: "Asia/Manila" });

  await boss.work(DAILY, async () => {
    const result = await runDailyOverdue(db, todayManila());
    console.log(JSON.stringify({ job: DAILY, ...result }));
    if (result.failures.length) throw new Error(`${result.failures.length} loans failed in the daily run`);
  });
  await boss.work(INTEGRITY, async () => {
    const result = await runIntegrityCheck(db);
    console.log(JSON.stringify({ job: INTEGRITY, ok: result.ok, mismatches: result.balanceMismatches.length, auditChain: result.auditChain }));
    // TODO(alerts): email Admin on failure once the mail provider is chosen (CLAUDE.md open decisions).
    if (!result.ok) throw new Error("Integrity check found mismatches");
  });

  console.log("worker started: daily overdue 00:30, integrity 01:00 (Asia/Manila)");
  const shutdown = async () => {
    await boss.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
