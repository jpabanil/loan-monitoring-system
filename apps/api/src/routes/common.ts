import { z } from "zod";

/** Money in the API is always integer centavos (₱4,727.98 → 472798). */
export const centavos = z.number().int().safe();
export const positiveCentavos = centavos.positive();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const idParam = z.object({ id: z.uuid() });
export const reason = z.string().trim().min(5, "Give a reason of at least 5 characters").max(500);

export const page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function paged<T>(items: T[], total: number, p: { page: number; pageSize: number }) {
  return { items, total, page: p.page, pageSize: p.pageSize };
}

export const passwordPolicy = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128)
  .regex(/[A-Za-z]/, "Include at least one letter")
  .regex(/\d/, "Include at least one number");
