import type { Database, Prisma } from "@rassa-jala/db";

// Audit action vocabulary (M-7 bitácora, backend-audit §2.6): short readable keys, one
// per audited mutation. `logs.acciones` returns the DB's DISTINCT values, so this const
// is the writer-side source of truth — the list filter stays a free string on purpose
// (new actions must not require a filter-schema change).
export const ACCION_LOG = {
  LOGIN: "auth.login",
  LOGIN_FALLIDO: "auth.login_fallido",
  LOGOUT: "auth.logout",
  REFRESH_RECHAZADO: "auth.refresh_rechazado",
  USUARIO_CREAR: "usuario.crear",
  USUARIO_CAMBIAR_ROL: "usuario.cambiar_rol",
  USUARIO_CAMBIAR_ESTADO: "usuario.cambiar_estado",
  USUARIO_RESTABLECER_PASSWORD: "usuario.restablecer_password",
  PRODUCTO_CREAR: "producto.crear",
  PRODUCTO_ACTUALIZAR: "producto.actualizar",
  PRODUCTO_CAMBIAR_ESTADO: "producto.cambiar_estado",
  PRODUCTO_IMAGEN_SUBIR: "producto.imagen_subir",
  PRODUCTO_IMAGEN_PRINCIPAL: "producto.imagen_principal",
  PRODUCTO_IMAGEN_ELIMINAR: "producto.imagen_eliminar",
  PUBLICACION_PUBLICAR: "publicacion.publicar",
  PUBLICACION_CANCELAR: "publicacion.cancelar",
  PEDIDO_CLAMAR: "pedido.clamar",
  PEDIDO_CANCELAR: "pedido.cancelar",
  PEDIDO_PAGO: "pedido.pago",
  PEDIDO_MARCAR_ENTREGADO: "pedido.marcar_entregado",
  MERMA_REGISTRAR: "merma.registrar",
  CORTE_CREAR: "corte.crear",
  LIQUIDACION_CALCULAR: "liquidacion.calcular",
  LIQUIDACION_MARCAR_PAGADA: "liquidacion.marcar_pagada",
} as const;

export type AccionLog = (typeof ACCION_LOG)[keyof typeof ACCION_LOG];

export type EntradaLog = {
  usuarioId?: string | null;
  accion: AccionLog;
  entidad?: string | null;
  entidadId?: string | null;
  ip?: string | null;
  dispositivo?: string | null;
  detalle?: Prisma.InputJsonValue;
};

// When the transport cannot resolve the client identity (offline/sync lanes without
// an HTTP request), callers omit ip/dispositivo and this sentinel fills the NOT NULL
// columns (M-7). The tRPC context now injects the real values (packages/api/src/
// context.ts), so router lanes pass ctx.ip/ctx.dispositivo and the sentinel only
// appears when the transport itself could not detect them.
const DESCONOCIDO = "unknown";

/**
 * Audit-trail writer (M-7; legacy `_log()` contract — "failures never break the caller").
 * Accepts the Database client OR an open Prisma.TransactionClient: money-critical
 * mutations pass their own tx (the audit row commits/rolls back WITH the mutation);
 * standalone calls (auth lanes) pass ctx.db. Best-effort by contract: any failure is
 * logged to the console and swallowed — it never fails the calling mutation.
 */
export async function registrarLog(
  cliente: Database | Prisma.TransactionClient,
  entrada: EntradaLog,
): Promise<void> {
  try {
    await cliente.log.create({
      data: {
        fkUsuario: entrada.usuarioId ?? null,
        accion: entrada.accion,
        entidad: entrada.entidad ?? null,
        entidadId: entrada.entidadId ?? null,
        ip: entrada.ip ?? DESCONOCIDO,
        dispositivo: (entrada.dispositivo ?? DESCONOCIDO).slice(0, 200),
        detalle: entrada.detalle,
      },
    });
  } catch (error) {
    console.error("[registrarLog] audit row failed (mutation continues):", error);
  }
}
