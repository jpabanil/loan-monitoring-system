import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { installments, loans, members, paymentAllocations, payments } from "../db/schema";
import { notFound } from "../lib/errors";
import { waivePenalty } from "../services/posting";
import { idParam, page, paged, reason } from "./common";
import { OPEN } from "./dashboard";

const memberCols = { id: members.id, memberNo: members.memberNo, firstName: members.firstName, lastName: members.lastName, mobile: members.mobile };

export async function loanRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      onRequest: app.requirePermission("loans.view"),
      schema: { querystring: page.extend({ status: z.enum(["active", "past_due", "fully_paid", "restructured", "written_off"]).optional(), q: z.string().trim().max(100).optional(), memberId: z.uuid().optional() }) },
    },
    async (req) => {
      const filters: SQL[] = [];
      if (req.query.status) filters.push(eq(loans.status, req.query.status));
      if (req.query.memberId) filters.push(eq(loans.memberId, req.query.memberId));
      if (req.query.q) {
        const like = `%${req.query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        filters.push(or(ilike(loans.loanNo, like), ilike(members.memberNo, like), sql`(${members.firstName} || ' ' || ${members.lastName}) ilike ${like}`)!);
      }
      const where = filters.length ? and(...filters) : undefined;
      const [rows, totals] = await Promise.all([
        app.db
          .select({ loan: loans, member: memberCols })
          .from(loans)
          .innerJoin(members, eq(members.id, loans.memberId))
          .where(where)
          .orderBy(desc(loans.releaseDate), desc(loans.loanNo))
          .limit(req.query.pageSize)
          .offset((req.query.page - 1) * req.query.pageSize),
        app.db.select({ total: count() }).from(loans).innerJoin(members, eq(members.id, loans.memberId)).where(where),
      ]);
      const total = totals[0]?.total ?? 0;
      const today = app.today();
      const ids = rows.map((r) => r.loan.id);
      const extras = ids.length
        ? await app.db
            .select({
              loanId: installments.loanId,
              nextDueDate: sql<string | null>`min(${installments.dueDate}) filter (where ${installments.status} <> 'paid')`,
              overdueAmount: sql<string>`coalesce(sum(${OPEN}) filter (where ${installments.status} <> 'paid' and ${installments.dueDate} < ${today}), 0)`,
              paidCount: sql<number>`(count(*) filter (where ${installments.status} = 'paid'))::int`,
              installmentCount: sql<number>`count(*)::int`,
            })
            .from(installments)
            .where(inArray(installments.loanId, ids))
            .groupBy(installments.loanId)
        : [];
      return paged(
        rows.map((r) => {
          const x = extras.find((e) => e.loanId === r.loan.id);
          return {
            ...r.loan,
            productName: (r.loan.productSnapshot as { name: string }).name,
            member: r.member,
            nextDueDate: x?.nextDueDate ?? null,
            overdueAmount: Number(x?.overdueAmount ?? 0),
            paidCount: x?.paidCount ?? 0,
            installmentCount: x?.installmentCount ?? 0,
          };
        }),
        total,
        req.query,
      );
    },
  );

  app.get("/:id", { onRequest: app.requirePermission("loans.view"), schema: { params: idParam } }, async (req) => {
    const [row] = await app.db.select({ loan: loans, member: memberCols }).from(loans).innerJoin(members, eq(members.id, loans.memberId)).where(eq(loans.id, req.params.id));
    if (!row) throw notFound("Loan");
    const schedule = await app.db.select().from(installments).where(eq(installments.loanId, row.loan.id)).orderBy(asc(installments.seq));
    const loanPayments = await app.db.select().from(payments).where(eq(payments.loanId, row.loan.id)).orderBy(desc(payments.createdAt));
    const next = schedule.find((i) => i.status !== "paid");
    return {
      ...row.loan,
      productName: (row.loan.productSnapshot as { name: string }).name,
      member: row.member,
      paidCount: schedule.filter((i) => i.status === "paid").length,
      nextDue: next
        ? {
            seq: next.seq,
            dueDate: next.dueDate,
            amount: next.principalDue - next.principalPaid + next.interestDue - next.interestPaid + next.penaltyDue - next.penaltyPaid - next.penaltyWaived,
          }
        : null,
      schedule,
      payments: loanPayments,
    };
  });

  app.get("/:id/schedule", { onRequest: app.requirePermission("loans.view"), schema: { params: idParam } }, async (req) => {
    const rows = await app.db.select().from(installments).where(eq(installments.loanId, req.params.id)).orderBy(asc(installments.seq));
    if (!rows.length) throw notFound("Loan");
    return rows;
  });

  app.get("/:id/payments", { onRequest: app.requirePermission("payments.view"), schema: { params: idParam } }, async (req) => {
    const rows = await app.db.select().from(payments).where(eq(payments.loanId, req.params.id)).orderBy(desc(payments.createdAt));
    const allocs = rows.length
      ? await app.db.select().from(paymentAllocations).where(inArray(paymentAllocations.paymentId, rows.map((r) => r.id)))
      : [];
    return rows.map((p) => ({ ...p, allocation: allocs.filter((a) => a.paymentId === p.id) }));
  });

  app.post("/:id/waive-penalty", { onRequest: app.requirePermission("penalties.waive"), schema: { params: idParam, body: z.object({ reason }) } }, async (req) =>
    app.db.transaction((tx) => waivePenalty(tx, req.actor, req.params.id, req.body.reason, app.today())),
  );
}
