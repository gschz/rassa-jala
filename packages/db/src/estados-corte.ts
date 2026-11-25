// Corte de caja domain constants — extracted from the legacy blueprint
// (legacy/rassa_back/rassa/blueprints/cortes + models.py Corte.ESTADO_CHOICES) and
// docs/database.md §3.5/M-15. Pure constants + pure calendar helpers — no I/O; shared
// by the API and the web client (subpath import avoids pulling Prisma in).
//
// Legacy contract encoded here:
// - ESTADO_CHOICES has three values (abierto/cerrado/cuadrado); the model default is
//   'abierto' but the ONLY legacy creation flow sets 'cerrado' at insert. There are
//   NO transition endpoints (no cerrar/ajustar lane) — never invent one.
// - C1: monto_teorico = sum of CASH pagos (tipo_pago name 'Efectivo', case-insensitive
//   legacy iexact parity) of the vendedor's pedidos for the local-timezone day —
//   bounds are the business day (America/Mazatlan), not the connection's UTC day
//   (legacy settings.TIME_ZONE note: a 23:59 local pago belongs to that local day).
// - C3: teorico/diferencia are creation-time snapshots; later pagos never
//   retro-update them. diferencia = monto_real - monto_teorico (DB CHECK, M-2).

export const ESTADO_CORTE = {
  ABIERTO: "abierto",
  CERRADO: "cerrado",
  CUADRADO: "cuadrado",
} as const;
export type EstadoCorte = (typeof ESTADO_CORTE)[keyof typeof ESTADO_CORTE];

/** The state every corte is created in (legacy create view parity). */
export const ESTADO_CORTE_CREACION = ESTADO_CORTE.CERRADO;

/** Cash payment-type name the teorico formula filters on (legacy iexact 'efectivo'). */
export const TIPO_PAGO_EFECTIVO = "Efectivo";

// ---- business-day bounds (America/Mazatlan — Q-22/D-6) ----

// America/Mazatlan is UTC-7 year-round since Mexico's 2022 DST repeal; the offset
// math below stays DST-robust anyway (two-iteration convergence) so a future zone
// change cannot silently shift the day's pagos window.

const FORMATO_PARED = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Mazatlan",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Wall-clock (Mazatlan) parts of an instant → the same instant expressed as UTC ms. */
function paredAUtc(instante: number): number {
  const partes = FORMATO_PARED.formatToParts(new Date(instante));
  const campo = (tipo: string): number => Number(partes.find((p) => p.type === tipo)?.value ?? 0);
  return Date.UTC(
    campo("year"),
    campo("month") - 1,
    campo("day"),
    campo("hour"),
    campo("minute"),
    campo("second"),
  );
}

/**
 * UTC instant whose Mazatlan wall clock is exactly `fecha` 00:00:00.
 * Fixed-point iteration X ← target − (wall(X) − X) with the pseudo-UTC wall clock
 * (converges in one step for a fixed offset; DST-robust in general).
 */
function inicioDiaUtc(fecha: string): number {
  const objetivo = Date.parse(`${fecha}T00:00:00Z`);
  let x = objetivo;
  for (let i = 0; i < 3; i++) {
    const siguiente = objetivo - (paredAUtc(x) - x);
    if (siguiente === x) break;
    x = siguiente;
  }
  return x;
}

/** 'YYYY-MM-DD' → next calendar day, same format (pure string math on real dates). */
function diaSiguiente(fecha: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) throw new Error(`Fecha inválida: ${fecha}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * C1 day window for `fecha` (Mazatlan business day, D-6): [inicio, fin) as UTC
 * instants — a pago with creado_en 23:59 local belongs to its LOCAL day, a pago at
 * 00:30 local of the next day does not. Used by the teorico computation; validated
 * by e2e boundary proofs.
 */
export function limitesDiaNegocio(fecha: string): { inicio: Date; fin: Date } {
  return {
    inicio: new Date(inicioDiaUtc(fecha)),
    fin: new Date(inicioDiaUtc(diaSiguiente(fecha))),
  };
}
