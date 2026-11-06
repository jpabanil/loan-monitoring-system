import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ledgerEntries, loans, members } from "../db/schema";
import { conflict, notFound, pgConstraint, pgErrorCode, unprocessable } from "../lib/errors";
import { writeAudit } from "../services/audit";
import { idParam, isoDate, page, paged } from "./common";

type MemberRow = typeof members.$inferSelect;
const PAST = { approve: "Approved", suspend: "Suspended", reactivate: "Reactivated" } as const;

const memberBody = z.object({
  firstName: z.string().trim().min(1).max(80),
  middleName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().min(1).max(80),
  birthdate: isoDate,
  sex: z.enum(["F", "M"]),
  civilStatus: z.string().trim().min(1).max(30),
  address: z.string().trim().min(5).max(300),
  mobile: z.string().regex(/^09\d{9}$/, "Use 11 digits starting with 09, e.g. 09171234567"),
  email: z.email().optional(),
  employment: z.string().trim().min(2).max(120),
  govIdType: z.string().trim().min(2).max(60),
  govIdNumber: z.string().trim().max(60).optional(),
});

/** Keeps sensitive ID numbers out of list views (CLAUDE.md: mask unless the role needs them). */
const listView = (m: MemberRow) => ({
  id: m.id,
  memberNo: m.memberNo,
  firstName: m.firstName,
  middleName: m.middleName,
  lastName: m.lastName,
  mobile: m.mobile,
  status: m.status,
  channel: m.channel,
  createdAt: m.createdAt,
});

const detailView = (m: MemberRow) => ({
  ...listView(m),
  birthdate: m.birthdate,
  sex: m.sex,
  civilStatus: m.civilStatus,
  address: m.address,
  email: m.email,
  employment: m.employment,
  govIdType: m.govIdType,
  govIdNumberMasked: m.govIdNumber ? `••••${m.govIdNumber.slice(-4)}` : null,
});

export async function memberRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      onRequest: app.requirePermission("members.view"),
      schema: { querystring: page.extend({ q: z.string().trim().max(100).optional(), status: z.enum(["pending", "active", "suspended", "closed"]).optional() }) },
    },
    async (req) => {
      const { q, status } = req.query;
      const filters: SQL[] = [];
      if (status) filters.push(eq(members.status, status));
      if (q) {
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        filters.push(or(ilike(members.memberNo, like), ilike(members.mobile, like), sql`(${members.firstName} || ' ' || ${members.lastName}) ilike ${like}`)!);
      }
      const where = filters.length ? and(...filters) : undefined;
      const [rows, totals] = await Promise.all([
        app.db.select().from(members).where(where).orderBy(asc(members.lastName), asc(members.firstName)).limit(req.query.pageSize).offset((req.query.page - 1) * req.query.pageSize),
        app.db.select({ total: count() }).from(members).where(where),
      ]);
      const total = totals[0]?.total ?? 0;
      const ids = rows.map((r) => r.id);
      const sums = ids.length
        ? await app.db
            .select({
              memberId: loans.memberId,
              openLoans: sql<number>`(count(*) filter (where ${loans.status} in ('active', 'past_due')))::int`,
              outstanding: sql<string>`coalesce(sum(${loans.totalBalance}) filter (where ${loans.status} in ('active', 'past_due')), 0)`,
            })
            .from(loans)
            .where(inArray(loans.memberId, ids))
            .groupBy(loans.memberId)
        : [];
      return paged(
        rows.map((m) => {
          const x = sums.find((s) => s.memberId === m.id);
          return { ...listView(m), openLoans: x?.openLoans ?? 0, outstanding: Number(x?.outstanding ?? 0) };
        }),
        total,
        req.query,
      );
    },
  );

  app.post(
    "/",
    { onRequest: app.requirePermission("members.edit"), schema: { body: memberBody.extend({ confirmDuplicate: z.boolean().optional() }) } },
    async (req, reply) => {
      const { confirmDuplicate, ...body } = req.body;
      // AT-MEM-04: same name + birthdate is a warning the user must confirm; same mobile is blocked by the unique index.
      if (!confirmDuplicate) {
        const [dup] = await app.db
          .select()
          .from(members)
          .where(and(sql`lower(${members.firstName}) = lower(${body.firstName})`, sql`lower(${members.lastName}) = lower(${body.lastName})`, eq(members.birthdate, body.birthdate)));
        if (dup) {
          throw conflict("POSSIBLE_DUPLICATE", `${dup.firstName} ${dup.lastName} (${dup.memberNo}) has the same name and birthdate. Send confirmDuplicate to register anyway.`, {
            memberId: dup.id,
            memberNo: dup.memberNo,
          });
        }
      }
      try {
        const created = await app.db.transaction(async (tx) => {
          const seq = await tx.execute<{ seq: string }>(sql`select nextval('member_no_seq')::text as seq`);
          const memberNo = `M-${new Date().getFullYear()}-${String(seq.rows[0]!.seq).padStart(6, "0")}`;
          const [m] = await tx.insert(members).values({ ...body, memberNo, status: "active", channel: "walk_in", createdBy: req.staff!.id }).returning();
          await writeAudit(tx, req.actor, { action: "member.create", entity: "member", entityId: memberNo, summary: `Registered ${m!.firstName} ${m!.lastName}`, after: { status: "active" } });
          return m!;
        });
        return reply.status(201).send(detailView(created));
      } catch (e) {
        if (pgErrorCode(e) === "23505" && pgConstraint(e) === "members_mobile_uq") throw conflict("MOBILE_TAKEN", "This mobile number already belongs to another member.");
        throw e;
      }
    },
  );

  app.get("/:id", { onRequest: app.requirePermission("members.view"), schema: { params: idParam } }, async (req) => {
    const [m] = await app.db.select().from(members).where(eq(members.id, req.params.id));
    if (!m) throw notFound("Member");
    const memberLoans = await app.db.select().from(loans).where(eq(loans.memberId, m.id)).orderBy(desc(loans.releaseDate));
    return {
      ...detailView(m),
      loans: memberLoans.map((l) => ({ id: l.id, loanNo: l.loanNo, productName: (l.productSnapshot as { name: string }).name, status: l.status, principal: l.principal, totalBalance: l.totalBalance, releaseDate: l.releaseDate })),
    };
  });

  app.patch("/:id", { onRequest: app.requirePermission("members.edit"), schema: { params: idParam, body: memberBody.partial() } }, async (req) =>
    app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(members).where(eq(members.id, req.params.id)).for("update");
      if (!before) throw notFound("Member");
      try {
        const [after] = await tx.update(members).set({ ...req.body, updatedAt: new Date() }).where(eq(members.id, before.id)).returning();
        const changed = Object.keys(req.body) as (keyof typeof req.body)[];
        await writeAudit(tx, req.actor, {
          action: "member.update",
          entity: "member",
          entityId: before.memberNo,
          summary: `Updated ${changed.join(", ")}`,
          before: Object.fromEntries(changed.map((k) => [k, before[k as keyof MemberRow]])),
          after: Object.fromEntries(changed.map((k) => [k, after![k as keyof MemberRow]])),
        });
        return detailView(after!);
      } catch (e) {
        if (pgErrorCode(e) === "23505" && pgConstraint(e) === "members_mobile_uq") throw conflict("MOBILE_TAKEN", "This mobile number already belongs to another member.");
        throw e;
      }
    }),
  );

  const transition = (action: "approve" | "suspend" | "reactivate", from: MemberRow["status"][], to: MemberRow["status"]) =>
    app.post(
      `/:id/${action}`,
      { onRequest: app.requirePermission(action === "approve" ? "members.approve" : "members.suspend"), schema: { params: idParam } },
      async (req) =>
        app.db.transaction(async (tx) => {
          const [m] = await tx.select().from(members).where(eq(members.id, req.params.id)).for("update");
          if (!m) throw notFound("Member");
          if (!from.includes(m.status)) throw unprocessable("INVALID_STATUS", `A ${m.status} member cannot be ${PAST[action].toLowerCase()}.`);
          const [after] = await tx.update(members).set({ status: to, updatedAt: new Date() }).where(eq(members.id, m.id)).returning();
          await writeAudit(tx, req.actor, {
            action: `member.${action}`,
            entity: "member",
            entityId: m.memberNo,
            summary: `${PAST[action]} ${m.firstName} ${m.lastName}`,
            before: { status: m.status },
            after: { status: to },
          });
          return detailView(after!);
        }),
    );
  transition("approve", ["pending"], "active");
  transition("suspend", ["active"], "suspended");
  transition("reactivate", ["suspended"], "active");

  /** Member ledger (AT-RPT-05): read straight from ledger_entries, with a running balance. */
  app.get("/:id/ledger", { onRequest: app.requirePermission("reports.all"), schema: { params: idParam } }, async (req) => {
    const rows = await app.db
      .select({
        id: ledgerEntries.id,
        loanNo: loans.loanNo,
        entryType: ledgerEntries.entryType,
        component: ledgerEntries.component,
        amount: ledgerEntries.amount,
        memo: ledgerEntries.memo,
        effectiveDate: ledgerEntries.effectiveDate,
        postedAt: ledgerEntries.postedAt,
      })
      .from(ledgerEntries)
      .innerJoin(loans, eq(loans.id, ledgerEntries.loanId))
      .where(eq(ledgerEntries.memberId, req.params.id))
      .orderBy(asc(ledgerEntries.postedAt), asc(ledgerEntries.id));
    let running = 0;
    return rows.map((r) => {
      if (r.component !== "fee") running += r.amount;
      return { ...r, runningBalance: running };
    });
  });
}
