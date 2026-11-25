// Gap 13 (#13) — the /recolecciones UI renders its action buttons from the SAME pure
// predicate the API enforces (transicionRecoleccion). These asserts pin the exact
// button-visibility semantics, including the B3 edge case: a `pendiente` whose fecha
// is TODAY must NOT show "Recolectado" (the server applies strict fecha < hoy bounds).
import { describe, expect, test } from "bun:test";

import { ESTADO_RECOLECCION, transicionRecoleccion } from "./estados-recoleccion";

const { PENDIENTE, EN_RUTA, RECOLECTADO } = ESTADO_RECOLECCION;

describe("transicionRecoleccion — UI action-gate parity (gap 13)", () => {
  const HOY = "2026-11-20";
  const AYER = "2026-11-19";
  const MANANA = "2026-11-21";

  test("pendiente vencida (fecha < hoy) muestra 'Recolectado' (salto B3) y 'Iniciar ruta' se oculta", () => {
    expect(transicionRecoleccion(PENDIENTE, RECOLECTADO, AYER, HOY).ok).toBe(true);
    expect(transicionRecoleccion(PENDIENTE, EN_RUTA, AYER, HOY).ok).toBe(false);
    expect(transicionRecoleccion(PENDIENTE, "cancelado", AYER, HOY).ok).toBe(true);
  });

  test("pendiente de HOY NO muestra 'Recolectado' (bound exacto del servidor)", () => {
    expect(transicionRecoleccion(PENDIENTE, RECOLECTADO, HOY, HOY).ok).toBe(false);
    expect(transicionRecoleccion(PENDIENTE, EN_RUTA, HOY, HOY).ok).toBe(true);
  });

  test("pendiente FUTURA no muestra 'Recolectado' ni 'Iniciar ruta' bloqueado", () => {
    expect(transicionRecoleccion(PENDIENTE, RECOLECTADO, MANANA, HOY).ok).toBe(false);
    expect(transicionRecoleccion(PENDIENTE, EN_RUTA, MANANA, HOY).ok).toBe(true);
  });

  test("en_ruta muestra 'Recolectado' con cualquier fecha y oculta 'Iniciar ruta'", () => {
    expect(transicionRecoleccion(EN_RUTA, RECOLECTADO, HOY, HOY).ok).toBe(true);
    expect(transicionRecoleccion(EN_RUTA, EN_RUTA, HOY, HOY).ok).toBe(false);
    expect(transicionRecoleccion(EN_RUTA, "cancelado", HOY, HOY).ok).toBe(true);
  });

  test("estados terminales ocultan todas las acciones", () => {
    expect(transicionRecoleccion(RECOLECTADO, RECOLECTADO, HOY, HOY).ok).toBe(false);
    expect(transicionRecoleccion("cancelado", "cancelado", HOY, HOY).ok).toBe(false);
  });
});
