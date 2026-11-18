import { describe, expect, test } from "bun:test";

import { aCentavos, aDecimal, importeDe, ivaDe, sumaCentavos, totalDe } from "./money";

// Q-14 (docs/scope.md §3.2): money math is integer-cents with HALF_UP; IVA 16%
// (D-3) applied over the FULL subtotal; total = subtotal + iva. These tests pin
// the exact contract the pedidos adjudication relies on — never float/Number.
describe("money", () => {
  test("pedido real (pedidos-e2e): 10.13 x [1,2,3] -> subtotal 60.78, iva 9.72, total 70.50", () => {
    const importes = [1, 2, 3].map((c) => importeDe(aCentavos("10.13"), c));
    expect(importes).toEqual([1013, 2026, 3039]);

    const subtotal = sumaCentavos(importes);
    expect(subtotal).toBe(6078);
    expect(aDecimal(subtotal)).toBe("60.78");

    const iva = ivaDe(subtotal);
    expect(iva).toBe(972); // HALF_UP(6078 * 16 / 100) = HALF_UP(972.48) = 972

    const total = totalDe(subtotal, iva);
    expect(total).toBe(7050);
    expect(aDecimal(total)).toBe("70.50");
  });

  test("HALF_UP: rounds up at .5 and above, down below (integer formula, no float drift)", () => {
    expect(ivaDe(aCentavos("0.03"))).toBe(0); // 0.48 -> 0
    expect(ivaDe(aCentavos("0.31"))).toBe(5); // 4.96 -> 5
    expect(ivaDe(aCentavos("1.55"))).toBe(25); // 24.8 -> 25
    expect(ivaDe(aCentavos("1.56"))).toBe(25); // 24.96 -> 25
  });

  test("aCentavos/aDecimal roundtrip keeps two-decimal money strings exact", () => {
    for (const s of ["0.00", "0.01", "10.13", "141.00", "999999.99"]) {
      expect(aDecimal(aCentavos(s))).toBe(s);
    }
  });

  test("importe is exact multiplication in cents (no float accumulation)", () => {
    expect(importeDe(aCentavos("0.11"), 3)).toBe(33); // 0.33, not 0.30000000000000004
    expect(importeDe(1013, 1_000_000)).toBe(1_013_000_000);
  });
});
