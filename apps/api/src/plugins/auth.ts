import { can, type Permission, type Role } from "@lms/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import fp from "fastify-plugin";
import { staffUsers } from "../db/schema";
import { AppError, forbidden } from "../lib/errors";
import { writeAudit, type Actor } from "../services/audit";

export const ACCESS_COOKIE = "lms_at";
export const REFRESH_COOKIE = "lms_rt";

export interface StaffPrincipal {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface AccessClaims {
  sub: string;
  typ: "staff";
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    staff?: StaffPrincipal;
    /** The acting person for audit entries; set by `authenticate`. */
    actor: Actor;
  }
  interface FastifyInstance {
    authenticate: onRequestAsyncHookHandler;
    requirePermission: (permission: Permission) => onRequestAsyncHookHandler;
  }
}

const unauthorized = () => new AppError(401, "UNAUTHENTICATED", "Please sign in again.");

function readToken(req: FastifyRequest): { token: string; viaCookie: boolean } | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return { token: header.slice(7), viaCookie: false };
  const cookie = req.cookies?.[ACCESS_COOKIE];
  return cookie ? { token: cookie, viaCookie: true } : null;
}

export default fp(async (app: FastifyInstance) => {
  app.decorateRequest("staff", undefined);
  app.decorateRequest("actor", null as unknown as Actor);

  app.decorate("authenticate", async (req: FastifyRequest, _reply: FastifyReply) => {
    const found = readToken(req);
    if (!found) throw unauthorized();

    // Cookie sessions: refuse cross-site writes (SameSite=Strict is the first line; this is the second).
    if (found.viaCookie && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== app.config.CORS_ORIGIN) throw forbidden("Cross-site request refused.");
    }

    let claims: AccessClaims;
    try {
      claims = app.jwt.verify<AccessClaims>(found.token);
    } catch {
      throw unauthorized();
    }
    if (claims.typ !== "staff") throw unauthorized();

    // Load the account on every request so deactivation and role changes apply at once (AT-AUTH-04).
    const [user] = await app.db.select().from(staffUsers).where(eq(staffUsers.id, claims.sub));
    if (!user || user.status !== "active") throw unauthorized();

    req.staff = { id: user.id, name: user.name, email: user.email, role: user.role };
    req.actor = { type: "staff", id: user.id, name: user.name, role: user.role, ip: req.ip, userAgent: req.headers["user-agent"] };
  });

  app.decorate("requirePermission", (permission: Permission): onRequestAsyncHookHandler => {
    return async function (req, reply) {
      await app.authenticate.call(this, req, reply);
      if (!can(req.staff!.role, permission)) {
        // AT-RBAC-01: denied attempts are audited.
        await app.db.transaction((tx) =>
          writeAudit(tx, req.actor, {
            action: "rbac.denied",
            entity: "permission",
            entityId: permission,
            summary: `Refused ${req.method} ${req.routeOptions.url ?? req.url} (needs ${permission})`,
          }),
        );
        throw forbidden();
      }
    };
  });
});
