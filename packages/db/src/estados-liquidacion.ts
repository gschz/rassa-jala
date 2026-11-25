// Liquidaciones domain constants (P1-B, M-16) — extracted from the legacy blueprint
// (legacy/rassa_back/rassa/blueprints/liquidaciones/constants.py + models.py) and
// docs/database.md §3.5/§4.7. Pure constants — no I/O; shared by the API and the web
// client (subpath import avoids pulling Prisma in).
//
// Legacy contract encoded here:
// - ESTADO_CHOICES has three values (pendiente/pagada/parcial, model default
//   'pendiente'); 'parcial' is RESERVED (no route produces it — the only writes are
//   calcular → 'pendiente' and marcar_pagada → 'pagada'). Never invent a transition
//   lane for it.
// - COMISION_RASSA = 0.10 is the ONLY commission rate; the request's tasa is ignored
//   (legacy test test_tasa_comision_en_request_es_ignorada). Kept as an exact decimal
//   string, never a float.
// - Week bounds (semana 1–53, anio 2000–2100) mirror the legacy serializer
//   SEMANA_MIN/MAX and ANIO_MIN/MAX; week existence is validated by the ISO round-trip
//   in iso-semana.lunesDeSemanaIso (legacy date.fromisocalendar parity).

export const ESTADO_LIQUIDACION = {
  PENDIENTE: "pendiente",
  PAGADA: "pagada",
  PARCIAL: "parcial",
} as const;
export type EstadoLiquidacion = (typeof ESTADO_LIQUIDACION)[keyof typeof ESTADO_LIQUIDACION];

/** The state every liquidación is created in (legacy calcular parity). */
export const ESTADO_LIQUIDACION_CREACION = ESTADO_LIQUIDACION.PENDIENTE;

/** Legacy COMISION_RASSA (constants.py Decimal("0.10")) — exact, never a float. */
export const TASA_COMISION_RASSA = "0.10";

/** Legacy serializer bounds (constants.py SEMANA_MIN/MAX, ANIO_MIN/MAX). */
export const SEMANA_MIN = 1;
export const SEMANA_MAX = 53;
export const ANIO_MIN = 2000;
export const ANIO_MAX = 2100;
