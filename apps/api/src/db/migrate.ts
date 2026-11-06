import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { grantSql, PRE_MIGRATION_SQL } from "./rules";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = path.join(here, "migrations");

/**
 * Runs as the owner role: extension, Drizzle schema migrations, then grants
 * for the app role. Safe to run repeatedly.
 */
export async function runMigrations(ownerUrl: string, appRole: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    for (const stmt of PRE_MIGRATION_SQL) await pool.query(stmt);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    for (const stmt of grantSql(appRole)) await pool.query(stmt);
  } finally {
    await pool.end();
  }
}

export function roleFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).username);
}
