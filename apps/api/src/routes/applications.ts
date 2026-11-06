import { formatPeso } from "@lms/shared";
import { and, asc, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { applicationStatusHistory, loanApplications, loanProducts, loans, members, notifications, staffUsers } from "../db/schema";
import { forbidden, notFound, unprocessable } from "../lib/errors";
import { writeAudit } from "../services/audit";
import { withIdempotency } from "../services/idempotency";
import { releaseLoan } from "../services/posting";
import { idParam, isoDate, page, paged, positiveCentavos, reason } from "./common";
import { checkProductLimits } from "./products";

type AppRow = typeof loanApplications.$inferSelect;
const STATUSES = ["submitted", "under_review", "approved", "declined", "cancelled", "released"] as const;

export async function applicationRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    { onRequest: app.requirePermission("applications.view"), schema: { querystring: page.extend({ status: z.enum(STATUSES).optional(), memberId: z.uuid().optional() }) } },
    async (req) => {
      const filters: SQL[] = [];
      if (req.query.status) filters.push(eq(loanApplications.status, req.query.status));
      if (req.query.memberId) filters.push(eq(loanApplications.memberId, req.query.memberId));
      const where = filters.length ? and(...filters) : undefined;
      const [rows, totals] = await Promise.all([
        app.db
          .select({ application: loanApplications, member: { id: members.id, memberNo: members.memberNo, firstName: members.firstName, lastName: members.lastName }, productName: loanProducts.name })
          .from(loanApplications)
          .innerJoin(members, eq(members.id, loanApplications.memberId))
          .innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
          .where(where)
          .orderBy(desc(loanApplications.createdAt))
          .limit(req.query.pageSize)
          .offset((req.query.page - 1) * req.query.pageSize),
        app.db.select({ total: count() }).from(loanApplications).where(where),
      ]);
      const total = totals[0]?.total ?? 0;
      return paged(rows.map((r) => ({ ...r.application, member: r.member, productName: r.productName })), total, req.query);
    },
  );

  /** Walk-in application encoded by staff (AT-APP-02). Mobile applications arrive through the member API. */
  app.post(
    "/",
    {
      onRequest: app.requirePermission("applications.encode"),
      schema: { body: z.object({ memberId: z.uuid(), productId: z.uuid(), amount: positiveCentavos, term: z.number().int().positive(), purpose: z.string().trim().min(3).max(300) }) },
    },
    async (req, reply) => {
      const created = await app.db.transaction(async (tx) => {
        // Lock the member so two concurrent applications cannot both pass the max-active-loans check.
        const [member] = await tx.select().from(members).where(eq(members.id, req.body.memberId)).for("update");
        if (!member) throw notFound("Member");
        if (member.status !== "active") throw unprocessable("MEMBER_NOT_ACTIVE", "Only active members can apply for a loan.");
        const [product] = await tx.select().from(loanProducts).where(eq(loanProducts.id, req.body.productId));
        if (!product) throw notFound("Loan product");
        checkProductLimits(product, req.body.amount, req.body.term);

        const [{ open }] = (await tx
          .select({ open: count() })
          .from(loans)
          .where(and(eq(loans.memberId, member.id), eq(loans.productId, product.id), inArray(loans.status, ["active", "past_due"])))) as [{ open: number }];
        const [{ pending }] = (await tx
          .select({ pending: count() })
          .from(loanApplications)
          .where(and(eq(loanApplications.memberId, member.id), eq(loanApplications.productId, product.id), inArray(loanApplications.status, ["submitted", "under_review", "approved"])))) as [{ pending: number }];
        if (open + pending >= product.maxActiveLoans) throw unprocessable("MAX_ACTIVE_LOANS", "Maximum active loans for this product reached.");

        const seq = await tx.execute<{ seq: string }>(sql`select nextval('application_no_seq')::text as seq`);
        const applicationNo = `APP-${new Date().getFullYear()}-${String(seq.rows[0]!.seq).padStart(6, "0")}`;
        const [a] = await tx
          .insert(loanApplications)
          .values({ ...req.body, applicationNo, channel: "walk_in", encodedBy: req.staff!.id })
          .returning();
        await tx.insert(applicationStatusHistory).values({ applicationId: a!.id, status: "submitted", changedBy: req.staff!.name });
        await writeAudit(tx, req.actor, {
          action: "application.create",
          entity: "loan_application",
          entityId: applicationNo,
          summary: `Encoded ${product.name} ${formatPeso(req.body.amount)} for ${member.firstName} ${member.lastName}`,
          after: { amount: req.body.amount, term: req.body.term },
        });
        return a!;
      });
      return reply.status(201).send(created);
    },
  );

  app.get("/counts", { onRequest: app.requirePermission("applications.view") }, async () => {
    const rows = await app.db.select({ status: loanApplications.status, n: count() }).from(loanApplications).groupBy(loanApplications.status);
    return Object.fromEntries(STATUSES.map((st) => [st, rows.find((r) => r.status === st)?.n ?? 0])) as Record<(typeof STATUSES)[number], number>;
  });

  app.get("/:id", { onRequest: app.requirePermission("applications.view"), schema: { params: idParam } }, async (req) => {
    const [a] = await app.db.select().from(loanApplications).where(eq(loanApplications.id, req.params.id));
    if (!a) throw notFound("Application");
    const [member] = await app.db
      .select({ id: members.id, memberNo: members.memberNo, firstName: members.firstName, lastName: members.lastName, mobile: members.mobile, status: members.status })
      .from(members)
      .where(eq(members.id, a.memberId));
    const [product] = await app.db.select().from(loanProducts).where(eq(loanProducts.id, a.productId));
    const names = await app.db
      .select({ id: staffUsers.id, name: staffUsers.name })
      .from(staffUsers)
      .where(inArray(staffUsers.id, [a.encodedBy, a.approvedBy].filter((x): x is string => !!x).concat("00000000-0000-0000-0000-000000000000")));
    const history = await app.db.select().from(applicationStatusHistory).where(eq(applicationStatusHistory.applicationId, a.id)).orderBy(asc(applicationStatusHistory.changedAt));
    const [loan] = await app.db.select({ id: loans.id, loanNo: loans.loanNo }).from(loans).where(eq(loans.applicationId, a.id));
    return {
      ...a,
      member,
      product,
      encodedByName: names.find((x) => x.id === a.encodedBy)?.name ?? null,
      approvedByName: names.find((x) => x.id === a.approvedBy)?.name ?? null,
      history,
      loan: loan ?? null,
    };
  });

  const move = (
    path: string,
    permission: "applications.encode" | "applications.approve",
    from: AppRow["status"][],
    to: AppRow["status"],
    opts: { needsReason?: boolean; fourEyes?: boolean } = {},
  ) =>
    app.post(
      `/:id/${path}`,
      {
        onRequest: app.requirePermission(permission),
        schema: { params: idParam, body: opts.needsReason ? z.object({ reason }) : z.object({ remarks: z.string().trim().max(500).optional() }).optional() },
      },
      async (req) =>
        app.db.transaction(async (tx) => {
          const [a] = await tx.select().from(loanApplications).where(eq(loanApplications.id, req.params.id)).for("update");
          if (!a) throw notFound("Application");
          if (!from.includes(a.status)) throw unprocessable("INVALID_STATUS", `An application that is ${a.status.replace("_", " ")} cannot be moved to ${to.replace("_", " ")}.`);
          // Four-eyes (AT-RBAC-02): whoever encoded the application cannot approve it.
          if (opts.fourEyes && a.encodedBy === req.staff!.id) throw forbidden("The encoder cannot approve this application.");
          const body = (req.body ?? {}) as { reason?: string; remarks?: string };
          const remarks = body.reason ?? body.remarks;
          const [after] = await tx
            .update(loanApplications)
            .set({ status: to, approvedBy: to === "approved" ? req.staff!.id : a.approvedBy, updatedAt: new Date() })
            .where(eq(loanApplications.id, a.id))
            .returning();
          await tx.insert(applicationStatusHistory).values({ applicationId: a.id, status: to, changedBy: req.staff!.name, remarks });
          await writeAudit(tx, req.actor, {
            action: `application.${path}`,
            entity: "loan_application",
            entityId: a.applicationNo,
            summary: remarks ? `${to.replace("_", " ")}: ${remarks}` : to.replace("_", " "),
            before: { status: a.status },
            after: { status: to },
          });
          const label = { under_review: "is under review", approved: "was approved", declined: "was declined", cancelled: "was cancelled" }[to as string] ?? to;
          await tx.insert(notifications).values({
            memberId: a.memberId,
            type: `application.${to}`,
            title: `Application ${a.applicationNo}`,
            body: `Your loan application ${label}${remarks && to === "declined" ? `: ${remarks}` : "."}`,
            data: { applicationId: a.id },
            channels: ["inbox", "push"],
          });
          return after!;
        }),
    );

  move("review", "applications.encode", ["submitted"], "under_review");
  move("approve", "applications.approve", ["submitted", "under_review"], "approved", { fourEyes: true });
  move("decline", "applications.approve", ["submitted", "under_review"], "declined", { needsReason: true });
  move("cancel", "applications.encode", ["submitted", "under_review", "approved"], "cancelled", { needsReason: true });

  app.post(
    "/:id/release",
    {
      onRequest: app.requirePermission("loans.release"),
      schema: { params: idParam, body: z.object({ releaseDate: isoDate.optional(), firstDueDate: isoDate.optional() }).optional() },
    },
    async (req, reply) => {
      const input = { applicationId: req.params.id, releaseDate: req.body?.releaseDate ?? app.today(), firstDueDate: req.body?.firstDueDate };
      const result = await app.db.transaction((tx) =>
        withIdempotency(
          tx,
          { actorId: req.staff!.id, key: req.headers["idempotency-key"] as string | undefined, endpoint: "release", request: input, statusCode: 201 },
          () => releaseLoan(tx, req.actor, input),
        ),
      );
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
