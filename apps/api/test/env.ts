/**
 * Test database settings. Integration tests run against a real PostgreSQL
 * (`lms_test`, created by `pnpm db:setup lms_test`), using the same owner/app
 * role split as production.
 */
function withDb(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const ownerDev = process.env.MIGRATION_DATABASE_URL ?? "postgres://lms_owner:lms_owner_dev@localhost:5432/lms_dev";
const appDev = process.env.DATABASE_URL ?? "postgres://lms_app:lms_app_dev@localhost:5432/lms_dev";

export const TEST_OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL ?? withDb(ownerDev, "lms_test");
export const TEST_APP_URL = process.env.TEST_DATABASE_URL ?? withDb(appDev, "lms_test");
