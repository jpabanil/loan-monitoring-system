import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "../db/client";
import { refreshTokens, staffUsers } from "../db/schema";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../lib/crypto";
import { AppError, unprocessable } from "../lib/errors";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp";
import { ACCESS_COOKIE, REFRESH_COOKIE, type AccessClaims } from "../plugins/auth";
import { writeAudit, type Actor } from "../services/audit";
import { passwordPolicy } from "./common";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REFRESH_DAYS = 7;
// Used when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = await hash("not-a-real-password-0");

type StaffRow = typeof staffUsers.$inferSelect;
interface ChallengeClaims {
  sub: string;
  typ: "mfa";
  purpose: "verify" | "setup";
}

const invalidLogin = () => new AppError(401, "INVALID_LOGIN", "Email or password is incorrect.");

export async function authRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const cfg = app.config;
  const secure = cfg.NODE_ENV === "production";

  const actorFor = (u: Pick<StaffRow, "id" | "name" | "role">, ip: string, ua?: string): Actor => ({
    type: "staff",
    id: u.id,
    name: u.name,
    role: u.role,
    ip,
    userAgent: ua,
  });

  const publicStaff = (u: StaffRow) => ({ id: u.id, name: u.name, email: u.email, role: u.role, twoFactor: !!u.totpEnabledAt });

  async function recordFailure(tx: Tx, u: StaffRow, actor: Actor, what: string) {
    const failed = u.failedLogins + 1;
    const lock = failed >= MAX_FAILED;
    await tx
      .update(staffUsers)
      .set({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : u.lockedUntil })
      .where(eq(staffUsers.id, u.id));
    await writeAudit(tx, actor, {
      action: lock ? "auth.locked" : "auth.failed",
      entity: "staff_user",
      entityId: u.email,
      summary: lock ? `Account locked for ${LOCK_MINUTES} minutes after ${MAX_FAILED} failed attempts` : `Failed sign-in (${what})`,
    });
    return lock;
  }

  function assertNotLocked(u: StaffRow) {
    if (u.status !== "active") throw invalidLogin();
    if (u.lockedUntil && u.lockedUntil > new Date()) {
      throw new AppError(423, "ACCOUNT_LOCKED", `This account is locked after too many failed attempts. Try again after ${LOCK_MINUTES} minutes or ask an Admin to unlock it.`);
    }
  }

  async function startSession(tx: Tx, u: StaffRow, reply: FastifyReply, familyId: string = randomUUID()) {
    const claims: AccessClaims = { sub: u.id, typ: "staff", role: u.role };
    const accessToken = app.jwt.sign(claims);
    const refreshToken = randomToken();
    await tx.insert(refreshTokens).values({
      userType: "staff",
      userId: u.id,
      tokenHash: sha256(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000),
    });
    reply.setCookie(ACCESS_COOKIE, accessToken, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 15 * 60 });
    reply.setCookie(REFRESH_COOKIE, refreshToken, { httpOnly: true, secure, sameSite: "strict", path: "/api/v1/auth", maxAge: REFRESH_DAYS * 86_400 });
    return { accessToken, refreshToken, expiresIn: 900 };
  }

  async function readChallenge(token: string, purpose: ChallengeClaims["purpose"]) {
    let claims: ChallengeClaims;
    try {
      claims = app.jwt.verify<ChallengeClaims>(token);
    } catch {
      throw new AppError(401, "CHALLENGE_EXPIRED", "Your sign-in took too long. Please start again.");
    }
    if (claims.typ !== "mfa" || claims.purpose !== purpose) throw new AppError(401, "CHALLENGE_INVALID", "Please start signing in again.");
    const [u] = await app.db.select().from(staffUsers).where(eq(staffUsers.id, claims.sub));
    if (!u) throw invalidLogin();
    assertNotLocked(u);
    return u;
  }

  const authLimit = { rateLimit: { max: cfg.AUTH_RATE_LIMIT, timeWindow: "1 minute" } };

  app.post(
    "/staff/login",
    {
      config: authLimit,
      schema: { body: z.object({ email: z.email().max(200), password: z.string().min(1).max(200) }) },
    },
    async (req) => {
      const email = req.body.email.toLowerCase();
      const [u] = await app.db.select().from(staffUsers).where(eq(staffUsers.email, email));
      if (!u) {
        await verify(DUMMY_HASH, req.body.password);
        throw invalidLogin();
      }
      assertNotLocked(u);
      if (!(await verify(u.passwordHash, req.body.password))) {
        const locked = await app.db.transaction((tx) => recordFailure(tx, u, actorFor(u, req.ip, req.headers["user-agent"]), "password"));
        if (locked) assertNotLocked({ ...u, lockedUntil: new Date(Date.now() + 60_000) });
        throw invalidLogin();
      }
      const purpose = u.totpEnabledAt ? "verify" : "setup";
      const challengeToken = app.jwt.sign({ sub: u.id, typ: "mfa", purpose } satisfies ChallengeClaims, { expiresIn: "5m" });
      return { step: purpose === "verify" ? ("totp" as const) : ("totp_setup" as const), challengeToken };
    },
  );

  app.post("/staff/2fa/setup", { config: authLimit, schema: { body: z.object({ challengeToken: z.string() }) } }, async (req) => {
    const u = await readChallenge(req.body.challengeToken, "setup");
    const secret = generateTotpSecret();
    await app.db.update(staffUsers).set({ totpSecret: encryptSecret(secret, cfg.DATA_ENCRYPTION_KEY) }).where(eq(staffUsers.id, u.id));
    return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
  });

  app.post(
    "/staff/2fa/confirm",
    { config: authLimit, schema: { body: z.object({ challengeToken: z.string(), code: z.string().regex(/^\d{6}$/) }) } },
    async (req, reply) => {
      const u = await readChallenge(req.body.challengeToken, "setup");
      if (!u.totpSecret) throw unprocessable("SETUP_NOT_STARTED", "Start two-factor setup first.");
      const step = verifyTotp(decryptSecret(u.totpSecret, cfg.DATA_ENCRYPTION_KEY), req.body.code);
      const actor = actorFor(u, req.ip, req.headers["user-agent"]);
      if (step === null) {
        await app.db.transaction((tx) => recordFailure(tx, u, actor, "two-factor setup code"));
        throw new AppError(401, "INVALID_CODE", "That code didn't match. Check your authenticator app and try again.");
      }
      const recoveryCodes = Array.from({ length: 8 }, () => randomToken(6).replace(/[-_]/g, "x").slice(0, 8).toLowerCase());
      return app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(staffUsers)
          .set({ totpEnabledAt: new Date(), totpLastStep: step, recoveryCodeHashes: recoveryCodes.map(sha256), failedLogins: 0, lastLoginAt: new Date() })
          .where(eq(staffUsers.id, u.id))
          .returning();
        await writeAudit(tx, actor, { action: "auth.2fa_enabled", entity: "staff_user", entityId: u.email, summary: "Set up two-factor sign-in" });
        await writeAudit(tx, actor, { action: "login", entity: "session", entityId: u.id, summary: "Signed in" });
        const session = await startSession(tx, updated!, reply);
        return { ...session, staff: publicStaff(updated!), recoveryCodes };
      });
    },
  );

  app.post(
    "/staff/2fa/verify",
    {
      config: authLimit,
      schema: {
        body: z
          .object({ challengeToken: z.string(), code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().max(20).optional() })
          .refine((b) => !!b.code !== !!b.recoveryCode, "Send either a code or a recovery code"),
      },
    },
    async (req, reply) => {
      const u = await readChallenge(req.body.challengeToken, "verify");
      const actor = actorFor(u, req.ip, req.headers["user-agent"]);
      let patch: Partial<StaffRow> = {};
      let how = "two-factor code";

      if (req.body.code) {
        const step = u.totpSecret ? verifyTotp(decryptSecret(u.totpSecret, cfg.DATA_ENCRYPTION_KEY), req.body.code) : null;
        // A code is accepted once: reject the step already used (replay) or earlier.
        if (step === null || (u.totpLastStep !== null && step <= u.totpLastStep)) {
          await app.db.transaction((tx) => recordFailure(tx, u, actor, "two-factor code"));
          throw new AppError(401, "INVALID_CODE", "That code didn't work. Wait for a new code and try again.");
        }
        patch = { totpLastStep: step };
      } else {
        const h = sha256(req.body.recoveryCode!.trim().toLowerCase());
        if (!u.recoveryCodeHashes.includes(h)) {
          await app.db.transaction((tx) => recordFailure(tx, u, actor, "recovery code"));
          throw new AppError(401, "INVALID_CODE", "That recovery code didn't work.");
        }
        patch = { recoveryCodeHashes: u.recoveryCodeHashes.filter((x) => x !== h) };
        how = "recovery code";
      }

      return app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(staffUsers)
          .set({ ...patch, failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
          .where(eq(staffUsers.id, u.id))
          .returning();
        await writeAudit(tx, actor, { action: "login", entity: "session", entityId: u.id, summary: `Signed in with ${how}` });
        const session = await startSession(tx, updated!, reply);
        return { ...session, staff: publicStaff(updated!) };
      });
    },
  );

  app.post("/refresh", { config: authLimit, schema: { body: z.object({ refreshToken: z.string().optional() }).optional() } }, async (req, reply) => {
    const token = req.body?.refreshToken ?? req.cookies[REFRESH_COOKIE];
    if (!token) throw new AppError(401, "UNAUTHENTICATED", "Please sign in again.");
    return app.db.transaction(async (tx) => {
      const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token))).for("update");
      if (!row || row.expiresAt < new Date()) throw new AppError(401, "UNAUTHENTICATED", "Please sign in again.");
      if (row.revokedAt) {
        // Reuse of a rotated token: someone may have stolen it. End the whole family.
        await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
        throw new AppError(401, "UNAUTHENTICATED", "Please sign in again.");
      }
      const [u] = await tx.select().from(staffUsers).where(eq(staffUsers.id, row.userId));
      if (!u || u.status !== "active") throw new AppError(401, "UNAUTHENTICATED", "Please sign in again.");
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
      const session = await startSession(tx, u, reply, row.familyId);
      return { ...session, staff: publicStaff(u) };
    });
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      await app.db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, sha256(token)), gt(refreshTokens.expiresAt, new Date())));
    }
    reply.clearCookie(ACCESS_COOKIE, { path: "/" });
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    return { ok: true };
  });

  app.get("/me", { onRequest: app.authenticate }, async (req) => {
    const [u] = await app.db.select().from(staffUsers).where(eq(staffUsers.id, req.staff!.id));
    return publicStaff(u!);
  });

  app.post(
    "/staff/change-password",
    { onRequest: app.authenticate, config: authLimit, schema: { body: z.object({ currentPassword: z.string(), newPassword: passwordPolicy }) } },
    async (req) => {
      const [u] = await app.db.select().from(staffUsers).where(eq(staffUsers.id, req.staff!.id));
      if (!u || !(await verify(u.passwordHash, req.body.currentPassword))) {
        throw new AppError(401, "INVALID_PASSWORD", "Your current password is incorrect.");
      }
      const passwordHash = await hash(req.body.newPassword);
      await app.db.transaction(async (tx) => {
        await tx.update(staffUsers).set({ passwordHash, updatedAt: new Date() }).where(eq(staffUsers.id, u.id));
        // Sign out other sessions.
        await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, u.id), isNull(refreshTokens.revokedAt)));
        await writeAudit(tx, req.actor, { action: "auth.password_changed", entity: "staff_user", entityId: u.email, summary: "Changed password" });
      });
      return { ok: true };
    },
  );
}
