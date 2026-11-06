import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { auditLogs } from "../db/schema";
import { page, paged } from "./common";

/** Read-only by design: there are no write routes, and the app role cannot UPDATE or DELETE audit_logs. */
export async function auditRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/",
    {
      onRequest: app.requirePermission("audit.view"),
      schema: {
        querystring: page.extend({
          entity: z.string().max(40).optional(),
          entityId: z.string().max(80).optional(),
          actorId: z.uuid().optional(),
          action: z.string().max(60).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const f: SQL[] = [];
      if (q.entity) f.push(eq(auditLogs.entity, q.entity));
      if (q.entityId) f.push(eq(auditLogs.entityId, q.entityId));
      if (q.actorId) f.push(eq(auditLogs.actorId, q.actorId));
      if (q.action) f.push(eq(auditLogs.action, q.action));
      if (q.from) f.push(gte(auditLogs.at, new Date(q.from)));
      if (q.to) f.push(lte(auditLogs.at, new Date(q.to)));
      const where = f.length ? and(...f) : undefined;
      const [rows, totals] = await Promise.all([
        app.db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
        app.db.select({ total: count() }).from(auditLogs).where(where),
      ]);
      const total = totals[0]?.total ?? 0;
      return paged(rows, total, q);
    },
  );
}
