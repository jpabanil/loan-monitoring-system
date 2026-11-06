import { roleFromUrl, runMigrations } from "../src/db/migrate";

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) {
  console.error("MIGRATION_DATABASE_URL and DATABASE_URL must be set.");
  process.exit(1);
}

runMigrations(ownerUrl, roleFromUrl(appUrl))
  .then(() => console.log("migrations applied"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
