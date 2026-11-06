import { asc, desc, sql } from "drizzle-orm";
import { sha256 } from "../lib/crypto";
import type { DbOrTx, Tx } from "../db/client";
import { auditLogs } from "../db/schema";

/** Who is acting, and from where. Built once per request. */
export interface Actor {
  type: "staff" | "member" | "system";
  id: string | null;
  name: string;
  role?: string;
  ip?: string;
  userAgent?: string;
}

export const SYSTEM_ACTOR: Actor = { type: "system", id: null, name: "System" };

export interface AuditInput {
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** JSON with sorted keys, so the hash survives jsonb's key reordering. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

interface HashFields {
  actorType: string;
  actorId: string | null;
  actorName: string;
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  before: unknown;
  after: unknown;
  at: Date;
}

export function auditHash(prevHash: string, f: HashFields): string {
  return sha256(
    `${prevHash}|${stableStringify({
      actorType: f.actorType,
      actorId: f.actorId,
      actorName: f.actorName,
      action: f.action,
      entity: f.entity,
      entityId: f.entityId,
      summary: f.summary,
      before: f.before ?? null,
      after: f.after ?? null,
      at: f.at.toISOString(),
    })}`,
  );
}

const GENESIS = "GENESIS";
/** Arbitrary constant: serializes audit writes so the hash chain stays linear. */
const AUDIT_CHAIN_LOCK = 7_243_001;

/**
 * Appends one audit entry, hash-chained to the previous one. Call inside the
 * same transaction as the change it records.
 */
export async function writeAudit(tx: Tx, actor: Actor, input: AuditInput): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
  const [last] = await tx.select({ hash: auditLogs.hash }).from(auditLogs).orderBy(desc(auditLogs.id)).limit(1);
  const prevHash = last?.hash ?? GENESIS;
  // Millisecond precision so the timestamp read back from Postgres hashes identically.
  const at = new Date(Math.floor(Date.now()));
  const fields: HashFields = {
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    summary: input.summary,
    before: input.before ?? null,
    after: input.after ?? null,
    at,
  };
  await tx.insert(auditLogs).values({
    ...fields,
    before: input.before ?? null,
    after: input.after ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    prevHash,
    hash: auditHash(prevHash, fields),
  });
}

/** Walks the whole chain; returns the first broken entry id, or null if intact. */
export async function verifyAuditChain(db: DbOrTx): Promise<{ brokenAtId: number | null; checked: number }> {
  let prev = GENESIS;
  let checked = 0;
  let lastId = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.id} > ${lastId}`)
      .orderBy(asc(auditLogs.id))
      .limit(1000);
    if (rows.length === 0) break;
    for (const r of rows) {
      const expected = auditHash(prev, r);
      if (r.prevHash !== prev || r.hash !== expected) return { brokenAtId: r.id, checked };
      prev = r.hash;
      checked += 1;
      lastId = r.id;
    }
  }
  return { brokenAtId: null, checked };
}
