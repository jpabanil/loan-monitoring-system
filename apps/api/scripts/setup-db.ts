/**
 * Development/test only: creates the owner and app roles and the databases,
 * using a superuser connection (ADMIN_DATABASE_URL). Production roles are
 * created by the hosting provider or an operator, never by this script.
 *
 *   pnpm db:setup            # lms_dev (from MIGRATION_DATABASE_URL / DATABASE_URL)
 *   pnpm db:setup lms_test   # an extra database for the integration tests
 */
import pg from "pg";

function parse(url: string | undefined, name: string) {
  if (!url) throw new Error(`${name} is not set`);
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) };
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Unsafe identifier: ${s}`);
  return s;
};

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("db:setup is for development and tests only.");
  const owner = parse(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL");
  const app = parse(process.env.DATABASE_URL, "DATABASE_URL");
  const databases = [owner.database, ...process.argv.slice(2)];
  const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL ?? "postgres://localhost:5432/postgres" });
  await admin.connect();
  try {
    for (const role of [owner, app]) {
      const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role.user]);
      const lit = admin.escapeLiteral(role.password);
      await admin.query(`${exists.rowCount ? "ALTER" : "CREATE"} ROLE ${ident(role.user)} LOGIN PASSWORD ${lit}`);
      console.log(`role ${role.user} ${exists.rowCount ? "updated" : "created"}`);
    }
    for (const db of databases) {
      const exists = await admin.query("select 1 from pg_database where datname = $1", [db]);
      if (!exists.rowCount) {
        await admin.query(`CREATE DATABASE ${ident(db)} OWNER ${ident(owner.user)}`);
        console.log(`database ${db} created`);
      }
      await admin.query(`REVOKE ALL ON DATABASE ${ident(db)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(app.user)}`);
    }
  } finally {
    await admin.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
