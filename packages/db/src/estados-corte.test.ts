// Pure tests for the corte day-window helper (C1 — database.md §4.7/M-15).
// America/Mazatlan is UTC-7 year-round (Mexico's 2022 DST repeal): the business day
// 'YYYY-MM-DD' spans [07:00Z, next day 07:00Z). A pago at 23:59 local belongs to its
// local day; one at 00:30 local of the next day does not (legacy settings.TIME_ZONE
// note in cortes/views.py — concepts, never copied).
import { describe, expect, test } from "bun:test";

import { ESTADO_CORTE, limitesDiaNegocio, TIPO_PAGO_EFECTIVO } from "./estados-corte";

describe("limitesDiaNegocio (ventana del día de negocio America/Mazatlan)", () => {
  test("el día local mapea a [07:00Z, +1d 07:00Z)", () => {
    const { inicio, fin } = limitesDiaNegocio("2027-07-01");
    expect(inicio.toISOString()).toBe("2027-07-01T07:00:00.000Z");
    expect(fin.toISOString()).toBe("2027-07-02T07:00:00.000Z");
  });

  test("el fin de año rueda el calendario correctamente", () => {
    const { inicio, fin } = limitesDiaNegocio("2027-12-31");
    expect(inicio.toISOString()).toBe("2027-12-31T07:00:00.000Z");
    expect(fin.toISOString()).toBe("2028-01-01T07:00:00.000Z");
  });

  test("un pago de 23:59 local entra; uno de 00:30 local del día siguiente no", () => {
    const { inicio, fin } = limitesDiaNegocio("2027-07-01");
    // 23:59 local 2027-07-01 = 2027-07-02T06:59Z → dentro de [07:00Z, 07:00Z+1d).
    const pagoNoche = new Date("2027-07-02T06:59:00.000Z");
    // 00:30 local 2027-07-02 = 2027-07-02T07:30Z → fuera (día siguiente).
    const pagoManana = new Date("2027-07-02T07:30:00.000Z");
    expect(pagoNoche >= inicio && pagoNoche < fin).toBe(true);
    expect(pagoManana >= inicio && pagoManana < fin).toBe(false);
  });
});

describe("constantes del dominio corte", () => {
  test("estados y tipo efectivo son los valores legacy", () => {
    expect(ESTADO_CORTE).toEqual({ ABIERTO: "abierto", CERRADO: "cerrado", CUADRADO: "cuadrado" });
    expect(TIPO_PAGO_EFECTIVO).toBe("Efectivo");
  });
});
