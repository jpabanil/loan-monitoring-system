import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? "postgres://localhost:5432/lms_dev" },
  strict: true,
});
