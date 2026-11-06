import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import { sha256 } from "../lib/crypto";
import { conflict, unprocessable } from "../lib/errors";
import { stableStringify } from "./audit";

export type IdempotentResult<T> = { replayed: false; statusCode: number; body: T } | { replayed: true; statusCode: number; body: unknown };

/**
 * Runs `fn` at most once per (actor, Idempotency-Key). The key row is written
 * in the same transaction as the posting, so a concurrent retry blocks on the
 * unique index until the first commits, then replays the stored response
 * (plan.md section 6, AT-PAY-07).
 */
export async function withIdempotency<T>(
  tx: Tx,
  opts: { actorId: string; key: string | undefined; endpoint: string; request: unknown; statusCode: number },
  fn: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  if (!opts.key) return { replayed: false, statusCode: opts.statusCode, body: await fn() };
  if (opts.key.length > 200) throw unprocessable("BAD_IDEMPOTENCY_KEY", "Idempotency-Key is too long.");

  const requestHash = sha256(`${opts.endpoint}|${stableStringify(opts.request)}`);
  const [claimed] = await tx
    .insert(idempotencyKeys)
    .values({ actorId: opts.actorId, key: opts.key, endpoint: opts.endpoint, requestHash })
    .onConflictDoNothing()
    .returning();

  if (!claimed) {
    const [existing] = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.actorId, opts.actorId), eq(idempotencyKeys.key, opts.key)));
    if (!existing || existing.requestHash !== requestHash) {
      throw unprocessable("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request.");
    }
    if (existing.response === null) throw conflict("REQUEST_IN_PROGRESS", "The same request is still being processed.");
    return { replayed: true, statusCode: existing.statusCode ?? 200, body: existing.response };
  }

  const body = await fn();
  await tx
    .update(idempotencyKeys)
    .set({ statusCode: opts.statusCode, response: JSON.parse(JSON.stringify(body)) })
    .where(eq(idempotencyKeys.id, claimed.id));
  return { replayed: false, statusCode: opts.statusCode, body };
}
