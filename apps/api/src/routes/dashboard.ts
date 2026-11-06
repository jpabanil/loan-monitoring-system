import { addDays, addMonths, agingBucket } from "@lms/shared";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { installments, loans, members, payments } from "../db/schema";

/** What is still owed on an installment, as SQL. */
export const OPEN = sql`(${installments.principalDue} - ${installments.principalPaid} + ${installments.interestDue} - ${installments.interestPaid} + ${installments.penaltyDue} - ${installments.penaltyPaid} - ${installments.penaltyWaived})`;

export async function dashboardRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = { onRequest: app.requirePermission("dashboard.view") };

  /** Figures for the dashboard tiles (AT-DSH-01): every number is a direct sum, no estimates. */
  app.get("/summary", guard, async () => {
    const today = app.today();
    const month = today.slice(0, 7);
    const [portfolio] = await app.db
      .select({
        outstanding: sql<string>`coalesce(sum(${loans.totalBalance}), 0)`,
        openLoans: sql<number>`count(*)::int`,
        pastDueLoans: sql<number>`count(*) filter (where ${loans.status} = 'past_due')::int`,
      })
      .from(loans)
      .where(inArray(loans.status, ["active", "past_due"]));
    const [released] = await app.db
      .select({ count: sql<number>`count(*)::int`, principal: sql<string>`coalesce(sum(${loans.principal}), 0)` })
      .from(loans)
      .where(sql`to_char(${loans.releaseDate}, 'YYYY-MM') = ${month}`);
    const [collections] = await app.db
      .select({
        month: sql<string>`coalesce(sum(${payments.amount}) filter (where to_char(${payments.paymentDate}, 'YYYY-MM') = ${month}), 0)`,
        today: sql<string>`coalesce(sum(${payments.amount}) filter (where ${payments.paymentDate} = ${today}), 0)`,
        todayCount: sql<number>`(count(*) filter (where ${payments.paymentDate} = ${today}))::int`,
      })
      .from(payments)
      .where(eq(payments.status, "posted"));
    const open = sql`(${installments.principalDue} - ${installments.principalPaid} + ${installments.interestDue} - ${installments.interestPaid} + ${installments.penaltyDue} - ${installments.penaltyPaid} - ${installments.penaltyWaived})`;
    const [dues] = await app.db
      .select({
        dueToday: sql<string>`coalesce(sum(${open}) filter (where ${installments.dueDate} = ${today}), 0)`,
        dueTodayCount: sql<number>`(count(*) filter (where ${installments.dueDate} = ${today}))::int`,
        overdue: sql<string>`coalesce(sum(${open}) filter (where ${installments.dueDate} < ${today}), 0)`,
      })
      .from(installments)
      .innerJoin(loans, eq(loans.id, installments.loanId))
      .where(and(inArray(loans.status, ["active", "past_due"]), sql`${installments.status} <> 'paid'`));
    return {
      asOf: today,
      portfolioOutstanding: Number(portfolio!.outstanding),
      openLoans: portfolio!.openLoans,
      pastDueLoans: portfolio!.pastDueLoans,
      releasedThisMonth: { count: released!.count, principal: Number(released!.principal) },
      collectionsThisMonth: Number(collections!.month),
      collectionsToday: Number(collections!.today),
      receiptsToday: collections!.todayCount,
      dueToday: Number(dues!.dueToday),
      dueTodayCount: dues!.dueTodayCount,
      overdueAmount: Number(dues!.overdue),
    };
  });

  /** Posted collections per month for the last N months, oldest first (voids excluded). */
  app.get("/collections", { ...guard, schema: { querystring: z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }) } }, async (req) => {
    const today = app.today();
    const months: string[] = [];
    for (let i = req.query.months - 1; i >= 0; i--) months.push(addMonths(`${today.slice(0, 7)}-01`, -i).slice(0, 7));
    const rows = await app.db
      .select({
        month: sql<string>`to_char(${payments.paymentDate}, 'YYYY-MM')`,
        amount: sql<string>`sum(${payments.amount})`,
        count: sql<number>`count(*)::int`,
      })
      .from(payments)
      .where(and(eq(payments.status, "posted"), gte(payments.paymentDate, `${months[0]}-01`), lte(payments.paymentDate, today)))
      .groupBy(sql`1`);
    return months.map((m) => {
      const r = rows.find((x) => x.month === m);
      return { month: m, amount: Number(r?.amount ?? 0), count: r?.count ?? 0, toDate: m === today.slice(0, 7) };
    });
  });

  /** Installments falling due from today through today + N days, on loans that are not past due. */
  app.get("/due", { ...guard, schema: { querystring: z.object({ days: z.coerce.number().int().min(0).max(31).default(0) }) } }, async (req) => {
    const today = app.today();
    const until = addDays(today, req.query.days);
    const rows = await app.db
      .select({
        loanId: loans.id,
        loanNo: loans.loanNo,
        productName: sql<string>`${loans.productSnapshot}->>'name'`,
        memberId: members.id,
        firstName: members.firstName,
        lastName: members.lastName,
        mobile: members.mobile,
        seq: installments.seq,
        dueDate: installments.dueDate,
        amount: sql<string>`${OPEN}`,
      })
      .from(installments)
      .innerJoin(loans, eq(loans.id, installments.loanId))
      .innerJoin(members, eq(members.id, loans.memberId))
      .where(and(eq(loans.status, "active"), gte(installments.dueDate, today), lte(installments.dueDate, until), sql`${installments.status} <> 'paid'`))
      .orderBy(asc(installments.dueDate), asc(loans.loanNo));
    return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
  });

  /** Outstanding balance by days past due (AT-OVD-05). Uses days_past_due kept by the daily job. */
  app.get("/aging", guard, async () => {
    const rows = await app.db
      .select({ daysPastDue: loans.daysPastDue, totalBalance: loans.totalBalance })
      .from(loans)
      .where(inArray(loans.status, ["active", "past_due"]));
    const buckets = { current: { count: 0, amount: 0 }, "1-30": { count: 0, amount: 0 }, "31-60": { count: 0, amount: 0 }, "61-90": { count: 0, amount: 0 }, "90+": { count: 0, amount: 0 } };
    for (const r of rows) {
      const b = buckets[agingBucket(r.daysPastDue)];
      b.count += 1;
      b.amount += r.totalBalance ?? 0;
    }
    return buckets;
  });
}
