import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../prisma/generated/client";
import type { DatabaseConfig } from "./config";

/**
 * Pins the Postgres session timezone to UTC for this stack's connections.
 *
 * Root cause (verified empirically, 2026-11-20): @prisma/adapter-pg serializes Date
 * params as bare UTC wall time WITHOUT an offset suffix (adapter-pg formatDateTime),
 * so PostgreSQL interprets the literal in the SESSION timezone — with the server's
 * default `America/Mazatlan` every timestamptz write landed +7h in the future (the
 * first instant-sensitive consumer is the corte teorico formula; the sync gap-window
 * age check is silently broken by the same shift). Reads are offset-aware and DATE/
 * TIME writes are bare literals, so a UTC session changes nothing else. timestamptz
 * writes then store the true instant (UTC == session).
 *
 * Idempotent: appends the libpq `options` startup parameter only when the URL has no
 * options yet; an explicit options in the URL is left untouched.
 */
export function conSesionUtc(url: string): string {
  if (/([?&])options=/.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}options=-c%20TimeZone%3DUTC`;
}

export function createPrismaClient(env: DatabaseConfig) {
  const adapter = new PrismaPg({
    connectionString: conSesionUtc(env.DATABASE_URL),
  });
  return new PrismaClient({ adapter });
}

export type Database = ReturnType<typeof createPrismaClient>;
export type { Prisma } from "../prisma/generated/client";
// ISO 8601 week calendar (Q-25) — shared pure helpers (API validation, seed, web client).
export {
  ESTADO_ITEM_SEMANAL,
  ESTADO_PUBLICACION,
  ZONA_NEGOCIO,
  aFechaCiclo,
  esLunesFecha,
  esLunesNegocio,
  hoyNegocio,
  isoWeekFromMonday,
  mondayOfBusinessWeek,
  parseFechaCiclo,
} from "./iso-semana";
export type { EstadoItemSemanal, EstadoPublicacion } from "./iso-semana";
// Order state catalog + origin values (P0 Pedidos, M-12) — shared pure constants.
export {
  ESTADOS_CANCELABLES_PEDIDO,
  ESTADOS_TERMINALES_PEDIDO,
  ESTADO_PEDIDO,
  ORIGEN_PEDIDO,
} from "./estados-pedido";
export type { EstadoPedido, OrigenPedido } from "./estados-pedido";
// Payment types catalog (P0 Pagos, M-13) — shared pure constants.
export { TIPO_PAGO } from "./tipos-pago";
export type { TipoPagoNombre } from "./tipos-pago";
// Recolección state machine (P0 Recolecciones, M-14) — shared pure constants.
export {
  ESTADOS_CANCELABLES_RECOLECCION,
  ESTADO_RECOLECCION,
  TRANSICIONES_RECOLECCION,
  transicionRecoleccion,
} from "./estados-recoleccion";
export type { EstadoRecoleccion, VeredictoTransicion } from "./estados-recoleccion";
// Corte de caja domain constants (P1 Cortes, M-15) — shared pure constants.
export {
  ESTADO_CORTE,
  ESTADO_CORTE_CREACION,
  TIPO_PAGO_EFECTIVO,
  limitesDiaNegocio,
} from "./estados-corte";
export type { EstadoCorte } from "./estados-corte";
// Liquidaciones domain constants (P1-B, M-16) — shared pure constants.
export {
  ANIO_MAX,
  ANIO_MIN,
  ESTADO_LIQUIDACION,
  ESTADO_LIQUIDACION_CREACION,
  SEMANA_MAX,
  SEMANA_MIN,
  TASA_COMISION_RASSA,
} from "./estados-liquidacion";
export type { EstadoLiquidacion } from "./estados-liquidacion";
// ISO week forward lookup (P1-B Liquidaciones) added to the shared calendar module.
export { lunesDeSemanaIso } from "./iso-semana";
