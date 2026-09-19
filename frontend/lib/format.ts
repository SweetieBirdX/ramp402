/**
 * docs/CONVENTIONS.md §1.1:
 * All amounts are integer stroops across the system.
 * Decimal conversion happens ONLY in frontend display components via lib/format.ts.
 * These two functions are the ONLY two places in the frontend where the 10_000_000 factor may appear.
 */

export const STROOPS_PER_UNIT = BigInt(10_000_000);

/**
 * Converts integer stroops (number or bigint) into a decimal display string (e.g. "0.29", "1.5").
 * Avoids floating point imprecision by using BigInt integer arithmetic.
 */
export function stroopsToDisplay(stroops: number | bigint): string {
  const s = typeof stroops === "bigint" ? stroops : BigInt(Math.trunc(Number(stroops)));
  const isNegative = s < BigInt(0);
  const abs = isNegative ? -s : s;
  const whole = abs / STROOPS_PER_UNIT;
  const fraction = abs % STROOPS_PER_UNIT;

  if (fraction === BigInt(0)) {
    return `${isNegative ? "-" : ""}${whole.toString()}`;
  }

  const fracStr = fraction.toString().padStart(7, "0").replace(/0+$/, "");
  return `${isNegative ? "-" : ""}${whole.toString()}.${fracStr}`;
}

/**
 * Converts a decimal display string (e.g. "0.29", "1.5") into integer stroops.
 * Uses exact string parsing rather than float multiplication to avoid precision loss
 * (e.g. 0.29 * 10_000_000 === 2899999.9999999995 in JavaScript IEEE-754 floats).
 */
export function displayToStroops(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) return 0;

  const isNegative = trimmed.startsWith("-");
  const clean = isNegative ? trimmed.slice(1) : trimmed;

  const parts = clean.split(".");
  if (parts.length > 2) {
    throw new Error(`Invalid number format: ${input}`);
  }

  const wholeStr = parts[0] || "0";
  let fracStr = parts[1] || "";

  if (fracStr.length > 7) {
    fracStr = fracStr.slice(0, 7);
  } else {
    fracStr = fracStr.padEnd(7, "0");
  }

  const whole = BigInt(wholeStr);
  const frac = BigInt(fracStr);
  const total = whole * STROOPS_PER_UNIT + frac;

  return Number(isNegative ? -total : total);
}
