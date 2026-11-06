import pg from "pg";
import { roleFromUrl, runMigrations } from "../src/db/migrate";
import { TEST_APP_URL, TEST_OWNER_URL } from "./env";

/** Rebuilds the test database from the migrations once per run. */
export default async function setup() {
  const owner = new pg.Client({ connectionString: TEST_OWNER_URL });
  try {
    await owner.connect();
  } catch (e) {
    throw new Error(
      `Cannot reach the test database at ${TEST_OWNER_URL.replace(/:[^:@/]+@/, ":•••@")}. Run \`pnpm db:setup lms_test\` first. (${(e as Error).message})`,
    );
  }
  await owner.query("DROP SCHEMA IF EXISTS public CASCADE");
  await owner.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await owner.query("CREATE SCHEMA public");
  await owner.end();
  await runMigrations(TEST_OWNER_URL, roleFromUrl(TEST_APP_URL));
}
