import { ROLES } from "@lms/shared";
import { hash } from "@node-rs/argon2";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { refreshTokens, staffUsers } from "../db/schema";
import { conflict, notFound, pgConstraint, pgErrorCode, unprocessable } from "../lib/errors";
import { writeAudit } from "../services/audit";
import { idParam, passwordPolicy } from "./common";

type StaffRow = typeof staffUsers.$inferSelect;
const view = (u: StaffRow) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  status: u.status,
  twoFactor: !!u.totpEnabledAt,
  locked: !!u.lockedUntil && u.lockedUntil > new Date(),
  lastLoginAt: u.lastLoginAt,
});

export async function staffRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = { onRequest: app.requirePermission("staff.manage") };

  app.get("/", guard, async () => {
    const rows = await app.db.select().from(staffUsers).orderBy(asc(staffUsers.name));
    return rows.map(view);
  });

  app.post(
    "/",
    { ...guard, schema: { body: z.object({ name: z.string().trim().min(2).max(120), email: z.email(), role: z.enum(ROLES as [string, ...string[]]), temporaryPassword: passwordPolicy }) } },
    async (req, reply) => {
      const passwordHash = await hash(req.body.temporaryPassword);
      try {
        const created = await app.db.transaction(async (tx) => {
          const [u] = await tx
            .insert(staffUsers)
            .values({ name: req.body.name, email: req.body.email.toLowerCase(), role: req.body.role as StaffRow["role"], passwordHash })
            .returning();
          await writeAudit(tx, req.actor, { action: "staff.create", entity: "staff_user", entityId: u!.email, summary: `Created ${u!.name} (${u!.role})`, after: { role: u!.role } });
          return u!;
        });
        return reply.status(201).send(view(created));
      } catch (e) {
        if (pgErrorCode(e) === "23505" && pgConstraint(e) === "staff_users_email_uq") throw conflict("EMAIL_TAKEN", "A staff account with this email already exists.");
        throw e;
      }
    },
  );

  app.patch(
    "/:id",
    {
      ...guard,
      schema: {
        params: idParam,
        body: z.object({ role: z.enum(ROLES as [string, ...string[]]).optional(), status: z.enum(["active", "deactivated"]).optional(), name: z.string().trim().min(2).optional() }),
      },
    },
    async (req) => {
      if (req.params.id === req.staff!.id && req.body.status === "deactivated") throw unprocessable("SELF_DEACTIVATE", "You cannot deactivate your own account.");
      return app.db.transaction(async (tx) => {
        const [before] = await tx.select().from(staffUsers).where(eq(staffUsers.id, req.params.id)).for("update");
        if (!before) throw notFound("Staff user");
        const [after] = await tx
          .update(staffUsers)
          .set({ ...(req.body as Partial<StaffRow>), updatedAt: new Date() })
          .where(eq(staffUsers.id, before.id))
          .returning();
        if (req.body.status === "deactivated") {
          await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, before.id), isNull(refreshTokens.revokedAt)));
        }
        await writeAudit(tx, req.actor, {
          action: "staff.update",
          entity: "staff_user",
          entityId: before.email,
          summary: `Updated ${before.name}`,
          before: { role: before.role, status: before.status, name: before.name },
          after: { role: after!.role, status: after!.status, name: after!.name },
        });
        return view(after!);
      });
    },
  );

  app.post("/:id/unlock", { ...guard, schema: { params: idParam } }, async (req) =>
    app.db.transaction(async (tx) => {
      const [u] = await tx.update(staffUsers).set({ lockedUntil: null, failedLogins: 0 }).where(eq(staffUsers.id, req.params.id)).returning();
      if (!u) throw notFound("Staff user");
      await writeAudit(tx, req.actor, { action: "staff.unlock", entity: "staff_user", entityId: u.email, summary: `Unlocked ${u.name}` });
      return view(u);
    }),
  );

  app.post("/:id/reset-2fa", { ...guard, schema: { params: idParam } }, async (req) =>
    app.db.transaction(async (tx) => {
      const [u] = await tx
        .update(staffUsers)
        .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodeHashes: [] })
        .where(eq(staffUsers.id, req.params.id))
        .returning();
      if (!u) throw notFound("Staff user");
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, u.id), isNull(refreshTokens.revokedAt)));
      await writeAudit(tx, req.actor, { action: "staff.reset_2fa", entity: "staff_user", entityId: u.email, summary: `Reset two-factor for ${u.name}` });
      return view(u);
    }),
  );
}
