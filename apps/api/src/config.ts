import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  /** Sign-in attempts allowed per IP per minute on the auth endpoints. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Pins "today" for UAT and tests (e.g. to walk through AT-OVD dates). Refused in production. */
  FIXED_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((c) => !(c.NODE_ENV === "production" && c.FIXED_DATE), { message: "FIXED_DATE cannot be set in production", path: ["FIXED_DATE"] });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
