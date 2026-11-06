import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { loans, members, paymentAllocations, payments } from "../db/schema";
import { notFound } from "../lib/errors";
import { withIdempotency } from "../services/idempotency";
import { postPayment, voidPayment } from "../services/posting";
import { idParam, isoDate, page, paged, positiveCentavos, reason } from "./common";

export async function paymentRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      onRequest: app.requirePermission("payments.post"),
      schema: {
        body: z.object({
          loanId: z.uuid(),
          amount: positiveCentavos,
          receiptNo: z.string().trim().min(1).max(30),
          method: z.enum(["cash", "bank", "e_wallet", "check"]),
          referenceNo: z.string().trim().max(60).optional(),
        }),
      },
    },
    async (req, reply) => {
      const input = { ...req.body, paymentDate: app.today() };
      const result = await app.db.transaction((tx) =>
        withIdempotency(
          tx,
          { actorId: req.staff!.id, key: req.headers["idempotency-key"] as string | undefined, endpoint: "payments.post", request: req.body, statusCode: 201 },
          () => postPayment(tx, req.actor, input),
        ),
      );
      return reply.status(result.statusCode).send(result.body);
    },
  );

  app.get(
    "/",
    {
      onRequest: app.requirePermission("payments.view"),
      schema: { querystring: page.extend({ from: isoDate.optional(), to: isoDate.optional(), loanId: z.uuid().optional(), status: z.enum(["posted", "voided"]).optional() }) },
    },
    async (req) => {
      const f: SQL[] = [];
      if (req.query.from) f.push(gte(payments.paymentDate, req.query.from));
      if (req.query.to) f.push(lte(payments.paymentDate, req.query.to));
      if (req.query.loanId) f.push(eq(payments.loanId, req.query.loanId));
      if (req.query.status) f.push(eq(payments.status, req.query.status));
      const where = f.length ? and(...f) : undefined;
      const [rows, totals] = await Promise.all([
        app.db
          .select({ payment: payments, loanNo: loans.loanNo, member: { id: members.id, memberNo: members.memberNo, firstName: members.firstName, lastName: members.lastName } })
          .from(payments)
          .innerJoin(loans, eq(loans.id, payments.loanId))
          .innerJoin(members, eq(members.id, payments.memberId))
          .where(where)
          .orderBy(desc(payments.createdAt))
          .limit(req.query.pageSize)
          .offset((req.query.page - 1) * req.query.pageSize),
        app.db.select({ total: count() }).from(payments).where(where),
      ]);
      const total = totals[0]?.total ?? 0;
      return paged(rows.map((r) => ({ ...r.payment, loanNo: r.loanNo, member: r.member })), total, req.query);
    },
  );

  app.get("/:id", { onRequest: app.requirePermission("payments.view"), schema: { params: idParam } }, async (req) => {
    const [p] = await app.db.select().from(payments).where(eq(payments.id, req.params.id));
    if (!p) throw notFound("Payment");
    const allocation = await app.db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, p.id));
    return { ...p, allocation };
  });

  app.post("/:id/void", { onRequest: app.requirePermission("payments.void"), schema: { params: idParam, body: z.object({ reason }) } }, async (req) =>
    app.db.transaction((tx) => voidPayment(tx, req.actor, req.params.id, req.body.reason, app.today())),
  );
}
