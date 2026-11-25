// Money math (Q-14 / D-3) — THE single entry point for every monetary computation in
// the API (and the web's display-only estimates). Normative sources: docs/scope.md §3.2
// Q-14 (subtotal = Σ importe; IVA = HALF_UP(subtotal × 16%, 2 dec); total = subtotal + iva;
// never float/Number as monetary authority; históricos never recomputed) and
// docs/database.md §4.6 (tasa 16% confirmed, M-2 snapshot CHECKs).
//
// Representation: integer cents (Cents) — the ONLY internal arithmetic form. Boundaries:
// - inbound: decimal STRING (zod-validated "digits(.dd)?") → aCentavos() — pure string
//   parsing, no float ever materializes;
// - outbound: cents → aDecimal() numeric(12,2) string (Prisma Decimal / RxDB string, F-29).
//
// HALF_UP proof: raw IVA cents = subtotal × 16 / 100. An exact half-cent requires
// (subtotal × 16) % 100 === 50, but subtotal × 16 is a multiple of 4 and 50 ≡ 2 (mod 4) —
// impossible, so `floor((n × 16 + 50) / 100)` in pure integer math is exact HALF_UP for
// every representable subtotal (verified: 10300 → 16.48; 6078 → 9.72).

export type Cents = number;

/** Decimal string "1234(.dd)?" → integer cents. Throws on malformed input. */
export function aCentavos(dinero: string): Cents {
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(dinero);
  if (!m) throw new Error(`Cantidad monetaria inválida: ${dinero}`);
  return Number(m[1] + (m[2] ?? "").padEnd(2, "0"));
}

/** Integer cents → numeric(12,2)-shaped string ("60.78"). Negative allowed for diffs. */
export function aDecimal(centavos: Cents): string {
  const signo = centavos < 0 ? "-" : "";
  const abs = Math.abs(centavos);
  return `${signo}${Math.trunc(abs / 100)}.${(abs % 100).toString().padStart(2, "0")}`;
}

/** Line importe: precio × cantidad — exact integer multiplication (Q-14). */
export function importeDe(precioCentavos: Cents, cantidad: number): Cents {
  return precioCentavos * cantidad;
}

/** Sum of money amounts (integer cents; safe up to 2^53). */
export function sumaCentavos(partidas: Cents[]): Cents {
  return partidas.reduce((acumulado, partida) => acumulado + partida, 0);
}

/** IVA 16% (D-3), HALF_UP to a cent, integer-only (see proof above). */
export function ivaDe(subtotalCentavos: Cents): Cents {
  return Math.floor((subtotalCentavos * 16 + 50) / 100);
}

/** Total = subtotal + iva (M-2 CHECK: total = subtotal + iva, exact in cents). */
export function totalDe(subtotalCentavos: Cents, ivaCentavos: Cents): Cents {
  return subtotalCentavos + ivaCentavos;
}
