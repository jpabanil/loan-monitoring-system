import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Config } from "./config";
import { createDb, type Db } from "./db/client";
import { AppError } from "./lib/errors";
import { todayManila } from "./lib/time";
import authPlugin from "./plugins/auth";
import { applicationRoutes } from "./routes/applications";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { loanRoutes } from "./routes/loans";
import { memberRoutes } from "./routes/members";
import { paymentRoutes } from "./routes/payments";
import { productRoutes } from "./routes/products";
import { staffRoutes } from "./routes/staff";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Business date in Asia/Manila (or FIXED_DATE outside production). */
    today: () => string;
  }
}

export type App = FastifyInstance;

export async function buildApp(config: Config, opts: { db?: Db } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.NODE_ENV === "test"
        ? false
        : {
            level: config.LOG_LEVEL,
            // Never log credentials, tokens or personal data (CLAUDE.md security rules).
            redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
            ...(config.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
          },
    trustProxy: config.NODE_ENV === "production",
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  let ownPool: { end: () => Promise<void> } | undefined;
  if (opts.db) {
    app.decorate("db", opts.db);
  } else {
    const { db, pool } = createDb(config.DATABASE_URL);
    app.decorate("db", db);
    ownPool = pool;
  }
  app.decorate("config", config);
  app.decorate("today", () => app.config.FIXED_DATE ?? todayManila());
  app.addHook("onClose", async () => {
    await ownPool?.end();
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.CORS_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_SECRET, sign: { expiresIn: "15m" } });
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);

  if (config.NODE_ENV !== "production") {
    await app.register(swagger, {
      openapi: { info: { title: "Loan Monitoring API", version: "0.1.0" } },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION",
          message: "Some fields are missing or invalid.",
          details: { issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) },
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: (err as { code?: string }).code ?? "BAD_REQUEST", message: (err as Error).message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong on our side. Please try again." } });
  });

  app.get("/health", { schema: { hide: true } }, async () => {
    await app.db.execute("select 1");
    return { status: "ok" };
  });

  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: "/auth" });
      await v1.register(staffRoutes, { prefix: "/staff-users" });
      await v1.register(memberRoutes, { prefix: "/members" });
      await v1.register(productRoutes, { prefix: "/loan-products" });
      await v1.register(applicationRoutes, { prefix: "/loan-applications" });
      await v1.register(loanRoutes, { prefix: "/loans" });
      await v1.register(paymentRoutes, { prefix: "/payments" });
      await v1.register(dashboardRoutes, { prefix: "/dashboard" });
      await v1.register(auditRoutes, { prefix: "/audit-logs" });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
