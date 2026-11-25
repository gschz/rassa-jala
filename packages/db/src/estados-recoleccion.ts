// Recolección state machine — EXACT legacy rules extracted from
// legacy/rassa_back/rassa/blueprints/recoleccion/{serializers,views,constants}.py
// (TRANSICIONES_VALIDAS, ESTADO_CHOICES) and database.md §3.5/M-14. Pure constants +
// pure transition predicate — no I/O; shared by the API and the web client (subpath
// import avoids pulling Prisma into the bundle).
//
// Legacy contract details encoded here:
// - cambiar_estado is STRICT: asking for the current state is an error (400), unlike
//   cancelar which is idempotent (200 "ya estaba cancelada").
// - Late-completion exception (B3, confirmed with business): a `pendiente` whose
//   fecha already passed may jump DIRECTLY to `recolectado` (the collection did
//   happen); it can NOT go `en_ruta` on a past date. `en_ruta`→`recolectado` is
//   allowed with ANY date; `cancelado` from pendiente/en_ruta is allowed regardless
//   of date.
// - `recolectado` and `cancelado` are terminal.

export const ESTADO_RECOLECCION = {
  PENDIENTE: "pendiente",
  EN_RUTA: "en_ruta",
  RECOLECTADO: "recolectado",
  CANCELADO: "cancelado",
} as const;
export type EstadoRecoleccion = (typeof ESTADO_RECOLECCION)[keyof typeof ESTADO_RECOLECCION];

// Legacy TRANSICIONES_VALIDAS (recoleccion/serializers.py).
export const TRANSICIONES_RECOLECCION: Readonly<
  Record<EstadoRecoleccion, readonly EstadoRecoleccion[]>
> = {
  [ESTADO_RECOLECCION.PENDIENTE]: [ESTADO_RECOLECCION.EN_RUTA, ESTADO_RECOLECCION.CANCELADO],
  [ESTADO_RECOLECCION.EN_RUTA]: [ESTADO_RECOLECCION.RECOLECTADO, ESTADO_RECOLECCION.CANCELADO],
  [ESTADO_RECOLECCION.RECOLECTADO]: [],
  [ESTADO_RECOLECCION.CANCELADO]: [],
};

// Estados from which a recoleccion can still be cancelled (legacy cancelar guard).
export const ESTADOS_CANCELABLES_RECOLECCION = [
  ESTADO_RECOLECCION.PENDIENTE,
  ESTADO_RECOLECCION.EN_RUTA,
] as const;

export type VeredictoTransicion = { ok: true } | { ok: false; motivo: string };

/**
 * Pure legacy transition check for `/estado/` (cambiar_estado) and `/cancelar/`.
 *
 * @param desde     current lifecycle value (must be a valid domain value).
 * @param hacia     requested state.
 * @param fechaRecoleccionUtc 'YYYY-MM-DD' business calendar date of the appointment.
 * @param hoyUtc    'YYYY-MM-DD' business "today" in America/Mazatlan (hoyNegocio()).
 */
export function transicionRecoleccion(
  desde: string,
  hacia: string,
  fechaRecoleccionUtc: string,
  hoyUtc: string,
): VeredictoTransicion {
  if (hacia === desde) {
    return { ok: false, motivo: "La recolección ya está en ese estado." };
  }
  // Late completion: a pendiente whose date already passed may jump DIRECTLY to
  // recolectado (the collection did happen — legacy early return), but going
  // en_ruta on a past date is blocked with the legacy message.
  if (
    desde === ESTADO_RECOLECCION.PENDIENTE &&
    fechaRecoleccionUtc < hoyUtc &&
    hacia === ESTADO_RECOLECCION.RECOLECTADO
  ) {
    return { ok: true };
  }
  if (
    desde === ESTADO_RECOLECCION.PENDIENTE &&
    fechaRecoleccionUtc < hoyUtc &&
    hacia !== ESTADO_RECOLECCION.CANCELADO
  ) {
    return {
      ok: false,
      motivo:
        "La fecha de la recolección ya pasó; solo se permite cancelarla o marcarla como recolectada.",
    };
  }
  const destino = TRANSICIONES_RECOLECCION[desde as EstadoRecoleccion];
  if (!destino?.includes(hacia as EstadoRecoleccion)) {
    return { ok: false, motivo: `No se puede cambiar de '${desde}' a '${hacia}'.` };
  }
  return { ok: true };
}
