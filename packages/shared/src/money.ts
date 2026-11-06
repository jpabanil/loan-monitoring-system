import Decimal from "decimal.js";

/**
 * Money rules (CLAUDE.md hard rule 4, plan.md 2.1):
 * - Amounts are integer centavos (₱4,727.98 is 472798). Never a float peso value.
 * - Arithmetic that can produce fractions uses decimal.js, then rounds once,
 *   ROUND_HALF_UP to the centavo, through `roundCentavos`. No other rounding exists.
 */
export type Centavos = number;

/** Decimal constructor with the system's precision and rounding rule. */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;

/** The one rounding rule: a centavo amount with fractions → whole centavos, half up. */
export function roundCentavos(value: Decimal.Value): Centavos {
  const rounded = new Dec(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return assertCentavos(rounded.toNumber());
}

/** Parses a peso amount typed by a person ("4,727.98", "50000") into centavos. */
export function pesosToCentavos(pesos: string | number): Centavos {
  const cleaned = typeof pesos === "number" ? String(pesos) : pesos.replace(/[₱,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new RangeError(`Not a valid peso amount: "${pesos}"`);
  }
  return assertCentavos(new Dec(cleaned).times(100).toNumber());
}

/** Guards against floats and values outside the safe integer range. */
export function assertCentavos(value: number): Centavos {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Centavo amounts must be safe integers, got ${value}`);
  }
  return value;
}

const pesoFormat = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactPesoFormat = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Display only: "₱4,727.98". The division here never feeds back into calculations. */
export function formatPeso(amount: Centavos): string {
  return pesoFormat.format(new Dec(amount).dividedBy(100).toNumber());
}

/** Display only, for axis labels and tight tiles: "₱1.2M". */
export function formatPesoCompact(amount: Centavos): string {
  return compactPesoFormat.format(new Dec(amount).dividedBy(100).toNumber());
}

export function sumCentavos(values: readonly Centavos[]): Centavos {
  return values.reduce((total, v) => assertCentavos(total + v), 0);
}
