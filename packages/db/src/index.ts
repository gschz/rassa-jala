import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../prisma/generated/client";
import type { DatabaseConfig } from "./config";

export function createPrismaClient(env: DatabaseConfig) {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
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
