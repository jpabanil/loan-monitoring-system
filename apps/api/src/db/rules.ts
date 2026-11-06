/**
 * Database rules applied by the migration (owner) role around the Drizzle
 * schema migrations. Kept in TypeScript so they are reviewable alongside the
 * schema; every statement is idempotent.
 *
 * CLAUDE.md hard rule 2: the app role has no UPDATE, DELETE or TRUNCATE on
 * ledger_entries or audit_logs. plan.md 2.1: no DELETE on financial tables.
 */

/** Must run before the schema migration (the members name index uses pg_trgm). */
export const PRE_MIGRATION_SQL = [`CREATE EXTENSION IF NOT EXISTS pg_trgm`];

/** Tables the app may delete from (housekeeping only; nothing tied to money). */
const DELETABLE = ["refresh_tokens", "idempotency_keys"];
/** Append-only tables: the app may only read and insert. */
const APPEND_ONLY = ["ledger_entries", "audit_logs"];

export function grantSql(appRole: string): string[] {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error(`Unsafe role name: ${appRole}`);
  return [
    `GRANT USAGE ON SCHEMA public TO ${appRole}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${appRole}`,
    `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${appRole}`,
    ...APPEND_ONLY.map((t) => `REVOKE UPDATE, DELETE, TRUNCATE ON ${t} FROM ${appRole}`),
    ...DELETABLE.map((t) => `GRANT DELETE ON ${t} TO ${appRole}`),
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`,
    // The Drizzle migrations journal is not the app's business.
    `REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM ${appRole}`,
  ];
}
