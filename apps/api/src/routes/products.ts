import { buildSchedule, Dec, roundCentavos } from "@lms/shared";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { loanProducts } from "../db/schema";
import { conflict, notFound, pgConstraint, pgErrorCode, unprocessable } from "../lib/errors";
import { writeAudit } from "../services/audit";
import { idParam, isoDate, positiveCentavos } from "./common";

type ProductRow = typeof loanProducts.$inferSelect;
const rate = z.string().regex(/^\d+(\.\d{1,6})?$/, "Use a decimal rate such as 0.02 for 2%");

const fields = {
  name: z.string().trim().min(2).max(80),
  description: z.string().max(300),
  interestRate: rate,
  method: z.enum(["diminishing", "add_on"]),
  frequency: z.enum(["weekly", "monthly"]),
  termsAllowed: z.array(z.number().int().min(1).max(120)).min(1),
  minAmount: positiveCentavos,
  maxAmount: positiveCentavos,
  feeRate: rate,
  penaltyRate: rate,
  graceDays: z.number().int().min(0).max(60),
  maxActiveLoans: z.number().int().min(1).max(10),
  active: z.boolean(),
};
const productBase = z.object({
  ...fields,
  code: z.string().trim().min(1).max(10),
  description: fields.description.default(""),
  feeRate: fields.feeRate.default("0"),
  maxActiveLoans: fields.maxActiveLoans.default(1),
  active: fields.active.default(true),
});
/** PATCH: no defaults, so omitted fields stay as they are. */
const productPatch = z.object(fields).partial();
const productBody = productBase.refine((p) => p.minAmount <= p.maxAmount, { message: "Minimum amount must not exceed maximum", path: ["minAmount"] });

/** Checks an amount and term against a product (plan.md 5.5, AT-PRD-04). */
export function checkProductLimits(p: ProductRow, amount: number, term: number) {
  if (!p.active) throw unprocessable("PRODUCT_INACTIVE", `${p.name} is not offered for new loans.`);
  if (amount < p.minAmount || amount > p.maxAmount) {
    const fmt = (c: number) => `₱${(c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;
    throw unprocessable("AMOUNT_OUT_OF_RANGE", `Amount must be between ${fmt(p.minAmount)} and ${fmt(p.maxAmount)}.`);
  }
  if (!p.termsAllowed.includes(term)) throw unprocessable("TERM_NOT_ALLOWED", `Term not allowed. Choose ${p.termsAllowed.join(", ")} periods.`);
}

export async function productRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get("/", { onRequest: app.requirePermission("products.view") }, async () => app.db.select().from(loanProducts).orderBy(asc(loanProducts.code)));

  app.post("/", { onRequest: app.requirePermission("products.edit"), schema: { body: productBody } }, async (req, reply) => {
    try {
      const created = await app.db.transaction(async (tx) => {
        const [p] = await tx.insert(loanProducts).values(req.body).returning();
        await writeAudit(tx, req.actor, { action: "product.create", entity: "loan_product", entityId: p!.code, summary: `Created ${p!.name}`, after: req.body });
        return p!;
      });
      return reply.status(201).send(created);
    } catch (e) {
      if (pgErrorCode(e) === "23505" && pgConstraint(e) === "loan_products_code_uq") throw conflict("CODE_TAKEN", "A product with this code already exists.");
      throw e;
    }
  });

  /** Edits apply to new loans only: released loans keep their product snapshot (AT-PRD-05). */
  app.patch(
    "/:id",
    { onRequest: app.requirePermission("products.edit"), schema: { params: idParam, body: productPatch } },
    async (req) =>
      app.db.transaction(async (tx) => {
        const [before] = await tx.select().from(loanProducts).where(eq(loanProducts.id, req.params.id)).for("update");
        if (!before) throw notFound("Loan product");
        const next = { ...before, ...req.body };
        if (next.minAmount > next.maxAmount) throw unprocessable("BAD_LIMITS", "Minimum amount must not exceed maximum.");
        const [after] = await tx.update(loanProducts).set({ ...req.body, updatedAt: new Date() }).where(eq(loanProducts.id, before.id)).returning();
        const changed = Object.keys(req.body) as (keyof ProductRow)[];
        await writeAudit(tx, req.actor, {
          action: "product.update",
          entity: "loan_product",
          entityId: before.code,
          summary: `Updated ${before.name}: ${changed.join(", ")}`,
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          after: Object.fromEntries(changed.map((k) => [k, after![k]])),
        });
        return after!;
      }),
  );

  app.post(
    "/:id/preview-schedule",
    {
      onRequest: app.requirePermission("products.view"),
      schema: { params: idParam, body: z.object({ amount: positiveCentavos, term: z.number().int().positive(), releaseDate: isoDate.optional() }) },
    },
    async (req) => {
      const [p] = await app.db.select().from(loanProducts).where(eq(loanProducts.id, req.params.id));
      if (!p) throw notFound("Loan product");
      checkProductLimits(p, req.body.amount, req.body.term);
      const schedule = buildSchedule({
        principal: req.body.amount,
        ratePerPeriod: p.interestRate,
        periods: req.body.term,
        method: p.method,
        frequency: p.frequency,
        releaseDate: req.body.releaseDate ?? app.today(),
      });
      const fee = roundCentavos(new Dec(req.body.amount).times(p.feeRate));
      return { ...schedule, fee, netProceeds: req.body.amount - fee };
    },
  );
}
