import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  ANIO_MAX,
  ANIO_MIN,
  ESTADO_LIQUIDACION,
  ESTADO_LIQUIDACION_CREACION,
  ESTADO_PEDIDO,
  SEMANA_MAX,
  SEMANA_MIN,
  TASA_COMISION_RASSA,
  lunesDeSemanaIso,
  limitesDiaNegocio,
} from "@rassa-jala/db";
import type { Prisma } from "@rassa-jala/db";

import { aCentavos, aDecimal, sumaCentavos } from "../money";
import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";
import { ACCION_LOG, registrarLog } from "../lib/registrar-log";
import { obtenerSiguienteFolio } from "./pagos";
import type { Database } from "@rassa-jala/db";

// P1-B Liquidaciones (docs/roadmap.md §6 P1-B; docs/database.md §3.5 rows + M-16,
// §4.2 uniques, §4.6/§4.7 formula validated 5/5; backend-audit L1-L9/F-05).
// Business rules extracted from the legacy blueprint
// (legacy/rassa_back/rassa/blueprints/liquidaciones/{views,serializers,constants}.py
// + tests/test_liquidaciones.py) — never copied:
//
// - calcular (Admin-only): input {agricultor (rol Agricultor + estado=true), semana
//   1-53, anio 2000-2100; ISO round-trip → 400 'La semana X no existe para el año Y.'}.
//   Period = ISO week [lunes, lunes+7d exclusive]; stored periodo_inicio = lunes,
//   periodo_fin = domingo. Ventas = pedidos estado 'entregado' whose Mazatlan
//   creado_en date falls in the window AND contain at least one DetallePedido of THIS
//   agricultor, EXCLUDING pedidos already in liquidacion_venta for him (C1 exclusion).
//   monto_ventas sums ONLY this agricultor's lines (multi-agricultor split); comision
//   = HALF_UP(monto_ventas × 0.10); monto_liquidar = ventas - comision; the request's
//   tasa is IGNORED (legacy test: tasa_comision_en_request_es_ignorada). Empty → 400.
// - L7: FULL UNIQUE (fk_agricultor, periodo_inicio, periodo_fin) — ANY state blocks
//   re-calculation (pendiente/parcial/pagada all count). Pre-check under the advisory
//   lock gives the legacy 409; P2002 maps to the same verdict.
// - L8: marcar_pagada (Admin-only) locks the row; pagada + same tipo_pago AND same
//   referencia → idempotent 200 with the detail; distinct data → 409 legacy message.
//   The dispersion pago is fk_pedido NULL, monto = monto_liquidar, folio from the
//   pago folio_secuencia ('pagos_folio' advisory, same machinery as pedido pagos);
//   NO recibo (legacy marcar_pagada never creates one). tipo_pago must exist.
// - Legacy inconsistency guards preserved: pendiente+pago → auto-fix to 'pagada';
//   pagada WITHOUT pago → 500 (single-writer v2 flow cannot produce it, but the guard
//   is the extracted legacy rule).
// - COL23 / sync (database.md §6.2 row): online-confirm module — server-fetched reads,
//   tRPC mutations with operationId idempotency, NO RxDB collection (web at the cap).
//   Outbox rows ride in ONE tx (M-1a) so a future PULL stays deliverable.
// - Money: money.ts integer cents end-to-end.

const ID = z.uuid();
const REFERENCIA = z.string().max(100);

// ---- DTO (money as string, dates ISO 8601 — database.md §6.3) ----

type VentaSnapshotDto = {
  fkPedido: string;
  clienteNombre: string | null;
  montoAportado: string;
  creadoEn: string;
  pagoFolio: string | null;
};

type PagoLiquidacionDto = {
  id: string;
  folio: string;
  tipoPagoNombre: string;
  monto: string;
  referencia: string | null;
  fechaPago: string;
};

interface LiquidacionDto {
  id: string;
  fkAgricultor: string | null;
  agricultorNombre: string | null;
  periodoInicio: string;
  periodoFin: string;
  montoVentas: string;
  tasaComision: string;
  comision: string;
  montoLiquidar: string;
  estado: string;
  folioPago: string | null;
  version: number;
  actualizadoEn: string;
  creadoEn: string;
  ventas: VentaSnapshotDto[];
  pago: PagoLiquidacionDto | null;
}

const inclDetalle = {
  agricultor: { include: { persona: true } },
  pagoLiquidacion: { include: { tipoPago: { select: { nombre: true } } } },
  ventas: {
    include: {
      pedido: {
        include: {
          cliente: { include: { persona: true } },
          pago: { select: { folio: true } },
        },
      },
    },
    orderBy: { creadoEn: "asc" as const },
  },
} as const satisfies Prisma.LiquidacionInclude;

type FilaDetalle = Prisma.LiquidacionGetPayload<{ include: typeof inclDetalle }>;

function nombrePersona(persona: { nombre: string; apellidoPaterno: string } | null): string | null {
  return persona ? `${persona.nombre} ${persona.apellidoPaterno}` : null;
}

function aDto(fila: FilaDetalle): LiquidacionDto {
  return {
    id: fila.id,
    fkAgricultor: fila.fkAgricultor,
    agricultorNombre: nombrePersona(fila.agricultor?.persona ?? null),
    periodoInicio: aFechaCicloLocal(fila.periodoInicio),
    periodoFin: aFechaCicloLocal(fila.periodoFin),
    montoVentas: fila.montoVentas.toFixed(2),
    tasaComision: fila.tasaComision.toFixed(4),
    comision: fila.comision.toFixed(2),
    montoLiquidar: fila.montoLiquidar.toFixed(2),
    estado: fila.estado,
    folioPago: fila.pagoLiquidacion?.folio ?? null,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    creadoEn: fila.creadoEn.toISOString(),
    ventas: fila.ventas.map((v) => ({
      fkPedido: v.fkPedido,
      clienteNombre: nombrePersona(v.pedido.cliente?.persona ?? null),
      montoAportado: v.montoAportado.toFixed(2),
      creadoEn: v.pedido.creadoEn.toISOString(),
      pagoFolio: v.pedido.pago?.folio ?? null,
    })),
    pago: fila.pagoLiquidacion
      ? {
          id: fila.pagoLiquidacion.id,
          folio: fila.pagoLiquidacion.folio,
          tipoPagoNombre: fila.pagoLiquidacion.tipoPago.nombre,
          monto: fila.pagoLiquidacion.monto.toFixed(2),
          referencia: fila.pagoLiquidacion.referencia,
          fechaPago: fila.pagoLiquidacion.creadoEn.toISOString(),
        }
      : null,
  };
}

// @db.Date comes back UTC-anchored — the ISO slice is the calendar date (iso-semana).
function aFechaCicloLocal(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

// ---- shared helpers ----

type OperacionOutbox = "insert" | "update";

/** M-1a: outbox rows ride in the SAME transaction as the row writes. */
async function escribirCambios(
  tx: Prisma.TransactionClient,
  actor: string,
  cambios: Array<{ tablaOrigen: string; idFila: string; operacion: OperacionOutbox }>,
): Promise<void> {
  if (cambios.length === 0) return;
  await tx.syncCambio.createMany({ data: cambios.map((c) => ({ ...c, actor })) });
}

function asegurarRol(rol: Role, permitidos: Role[], mensaje: string): void {
  if (!permitidos.includes(rol)) {
    throw new TRPCError({ code: "FORBIDDEN", message: mensaje });
  }
}

const SOLO_ADMIN: Role[] = [ROLE.ADMIN];
const MSG_SOLO_ADMIN = "Solo el rol Admin consulta liquidaciones";

/**
 * Domain rejection sentinel: thrown INSIDE the mutation transaction so every effect
 * rolls back; the runner maps it to the legacy HTTP code (400/404/409/500).
 */
export class RechazoLiquidacion extends Error {
  constructor(
    motivo: string,
    readonly codigo:
      | "BAD_REQUEST"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INTERNAL_SERVER_ERROR" = "BAD_REQUEST",
  ) {
    super(motivo);
    this.name = "RechazoLiquidacion";
  }
}

// Legacy MSG_LIQUIDACION_DUPLICADA (constants.py) — the id is a UUID in v2.
function msgDuplicada(id: string): string {
  return `Ya existe la liquidación #${id} para ese agricultor y periodo.`;
}

const MSG_SIN_VENTAS = "No hay ventas entregadas para este agricultor en el periodo.";

/** Legacy COMISION_RASSA 0.10, HALF_UP to a cent in pure integer math. */
function comisionDe(ventasCentavos: number): number {
  const [entero, resto] = TASA_COMISION_RASSA.split(".");
  const numerador = Number(entero) * 100 + Number((resto ?? "").padEnd(2, "0").slice(0, 2) || 0);
  return Math.floor((ventasCentavos * numerador + 50) / 100);
}

// ---- THE single calculation entry point (L7) ----

type EntradaCalcular = {
  agricultorId: string;
  semana: number;
  anio: number;
  actor: string;
  // Audit identity for the router (HTTP) lane; the offline lane omits them.
  ip?: string | null;
  dispositivo?: string | null;
};

/**
 * L7 central calculation. Inside ONE tx, serialized by the advisory lock
 * 'liquidaciones_calculo':
 *  a. pre-check the any-state duplicate (the FULL unique is the last word — P2002
 *     maps to the same 409);
 *  b. delivered-pedido window query + C1 exclusion, re-validated under the lock;
 *  c. multi-agricultor split + HALF_UP commission in integer cents;
 *  d. liquidacion + L6 snapshot rows + outbox — one tx.
 *
 * Throws RechazoLiquidacion on domain failure.
 */
async function adjudicarLiquidacion(
  tx: Prisma.TransactionClient,
  entrada: EntradaCalcular,
): Promise<LiquidacionDto> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('liquidaciones_calculo'))`;

  // Legacy _rango_semana: [lunes, lunes+7) as business-TZ instants; stored dates are
  // lunes (inicio) and domingo (fin_exclusive - 1 day).
  const lunes = lunesDeSemanaIso(entrada.anio, entrada.semana);
  const finExclusivo = new Date(lunes);
  finExclusivo.setUTCDate(finExclusivo.getUTCDate() + 7);
  const domingo = new Date(lunes);
  domingo.setUTCDate(domingo.getUTCDate() + 6);

  // a. L7 pre-check: ANY state counts (pendiente/parcial/pagada — legacy 409).
  const existente = await tx.liquidacion.findFirst({
    where: {
      fkAgricultor: entrada.agricultorId,
      periodoInicio: lunes,
      periodoFin: domingo,
    },
    select: { id: true },
  });
  if (existente) throw new RechazoLiquidacion(msgDuplicada(existente.id), "CONFLICT");

  // b. Delivered pedidos in the week containing THIS agricultor's lines, excluding
  //    pedidos already liquidated for him (C1 exclusion — legacy Exists subquery).
  const idEntregado = await tx.estadoPedido.findUnique({
    where: { nombre: ESTADO_PEDIDO.ENTREGADO },
    select: { id: true },
  });
  if (!idEntregado) {
    throw new RechazoLiquidacion(
      "Error de configuración: estado 'entregado' no está en la BD. Contacta al administrador.",
      "INTERNAL_SERVER_ERROR",
    );
  }
  const { inicio } = limitesDiaNegocio(aFechaCicloLocal(lunes));
  const { inicio: finSemana } = limitesDiaNegocio(aFechaCicloLocal(finExclusivo));

  const ventas = await tx.pedidoCabecera.findMany({
    where: {
      detalles: {
        some: { productoSemanal: { publicacion: { fkAgricultor: entrada.agricultorId } } },
      },
      fkEstado: idEntregado.id,
      // creado_en DATE in the business TZ (legacy __date lookup) — Mazatlan day bounds.
      creadoEn: { gte: inicio, lt: finSemana },
      // C1: exclude pedidos already liquidated for THIS agricultor (any period).
      liquidacionesVenta: { none: { liquidacion: { fkAgricultor: entrada.agricultorId } } },
    },
    include: { cliente: { include: { persona: true } } },
    orderBy: { creadoEn: "asc" },
  });
  if (ventas.length === 0) throw new RechazoLiquidacion(MSG_SIN_VENTAS);

  // Multi-agricultor split: sum ONLY this agricultor's lines per pedido.
  const misItems = new Set(
    (
      await tx.productoSemanal.findMany({
        where: { publicacion: { fkAgricultor: entrada.agricultorId } },
        select: { id: true },
      })
    ).map((i) => i.id),
  );
  const detalles = await tx.detallePedido.findMany({
    where: {
      fkPedido: { in: ventas.map((p) => p.id) },
      fkProductoSemanal: { in: [...misItems] },
    },
    select: { fkPedido: true, importe: true },
  });
  const aportePorPedido = new Map<string, number>();
  for (const d of detalles) {
    aportePorPedido.set(
      d.fkPedido,
      (aportePorPedido.get(d.fkPedido) ?? 0) + aCentavos(d.importe.toFixed(2)),
    );
  }
  const ventasCents = sumaCentavos([...aportePorPedido.values()]);
  const comisionCents = comisionDe(ventasCents);
  const liquidarCents = ventasCents - comisionCents;

  // d. Row + L6 snapshot + outbox — ONE tx. estado 'pendiente' (legacy parity).
  let creado;
  try {
    creado = await tx.liquidacion.create({
      data: {
        fkAgricultor: entrada.agricultorId,
        periodoInicio: lunes,
        periodoFin: domingo,
        montoVentas: aDecimal(ventasCents),
        tasaComision: TASA_COMISION_RASSA,
        comision: aDecimal(comisionCents),
        montoLiquidar: aDecimal(liquidarCents),
        estado: ESTADO_LIQUIDACION_CREACION,
      },
      include: inclDetalle,
    });
  } catch (error) {
    // A racer that slipped past the pre-check hits the FULL unique.
    if ((error as { code?: string }).code === "P2002") {
      const duplicada = await tx.liquidacion.findFirst({
        where: {
          fkAgricultor: entrada.agricultorId,
          periodoInicio: lunes,
          periodoFin: domingo,
        },
        select: { id: true },
      });
      throw new RechazoLiquidacion(
        duplicada
          ? msgDuplicada(duplicada.id)
          : "Ya existe la liquidación para ese agricultor y periodo.",
        "CONFLICT",
      );
    }
    throw error;
  }
  await tx.liquidacionVenta.createMany({
    data: ventas.map((p) => ({
      fkLiquidacion: creado.id,
      fkPedido: p.id,
      montoAportado: aDecimal(aportePorPedido.get(p.id) ?? 0),
    })),
  });
  // Outbox id_fila must identify the created snapshot rows: re-read their ids (a
  // handful of rows) instead of faking a per-row createMany return.
  const ventasIds = (
    await tx.liquidacionVenta.findMany({
      where: { fkLiquidacion: creado.id },
      select: { id: true },
    })
  ).map((v) => v.id);
  await escribirCambios(tx, entrada.actor, [
    { tablaOrigen: "liquidacion", idFila: creado.id, operacion: "insert" },
    ...ventasIds.map((id) => ({
      tablaOrigen: "liquidacion_venta",
      idFila: id,
      operacion: "insert" as OperacionOutbox,
    })),
  ]);
  await registrarLog(tx, {
    usuarioId: entrada.actor,
    accion: ACCION_LOG.LIQUIDACION_CALCULAR,
    entidad: "liquidacion",
    entidadId: creado.id,
    ip: entrada.ip,
    dispositivo: entrada.dispositivo,
    detalle: {
      fkAgricultor: entrada.agricultorId,
      semana: entrada.semana,
      anio: entrada.anio,
    },
  });

  // The snapshot rows just inserted must appear in the returned detail: re-fetch
  // through the same include shape (legacy _reload_liquidacion parity).
  const fila = await tx.liquidacion.findUnique({
    where: { id: creado.id },
    include: inclDetalle,
  });
  if (!fila)
    throw new RechazoLiquidacion("La liquidación no pudo recargarse.", "INTERNAL_SERVER_ERROR");
  return aDto(fila);
}

// ---- THE single payment entry point (L8) ----

type EntradaPago = {
  liquidacionId: string;
  fkTipoPago: string;
  referencia: string | null;
  actor: string;
  // Audit identity for the router (HTTP) lane; the offline lane omits them.
  ip?: string | null;
  dispositivo?: string | null;
};

/**
 * L8 idempotent payment. Inside ONE tx, serialized by the advisory lock
 * 'liquidaciones_pago' + row lock (legacy select_for_update parity):
 *  - not found → 404;
 *  - inconsistency guards (legacy C8): pendiente+pago → auto-fix 'pagada'; pagada
 *    without pago → 500;
 *  - pagada: same tipo_pago AND same referencia → idempotent 200; distinct → 409;
 *  - otherwise create the dispersion pago (fk_pedido NULL, folio from 'pagos_folio',
 *    monto = monto_liquidar, NO recibo), set fk_pago_liquidacion + estado 'pagada'
 *    and write the outbox — one tx.
 */
async function pagarLiquidacion(
  tx: Prisma.TransactionClient,
  entrada: EntradaPago,
): Promise<LiquidacionDto> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('liquidaciones_pago'))`;
  await tx.$executeRaw`SELECT id FROM liquidacion WHERE id = ${entrada.liquidacionId}::uuid FOR UPDATE`;

  const fila = await tx.liquidacion.findUnique({
    where: { id: entrada.liquidacionId },
    include: inclDetalle,
  });
  if (!fila) {
    throw new RechazoLiquidacion("Liquidación no encontrada.", "NOT_FOUND");
  }

  // Legacy C8 inconsistency guards (data repair / hard error).
  if (fila.estado === ESTADO_LIQUIDACION.PENDIENTE && fila.fkPagoLiquidacion) {
    await tx.liquidacion.update({
      where: { id: fila.id },
      data: { estado: ESTADO_LIQUIDACION.PAGADA },
    });
    fila.estado = ESTADO_LIQUIDACION.PAGADA;
  }
  if (fila.estado === ESTADO_LIQUIDACION.PAGADA && !fila.fkPagoLiquidacion) {
    throw new RechazoLiquidacion(
      "Inconsistencia de datos: la liquidación no tiene registro de pago.",
      "INTERNAL_SERVER_ERROR",
    );
  }

  if (fila.estado === ESTADO_LIQUIDACION.PAGADA || fila.fkPagoLiquidacion) {
    const pago = fila.pagoLiquidacion;
    if (pago) {
      const mismaHuella =
        pago.fkTipoPago === entrada.fkTipoPago &&
        (pago.referencia ?? "") === (entrada.referencia ?? "");
      if (!mismaHuella) {
        throw new RechazoLiquidacion(
          `La liquidación ya fue pagada previamente con datos distintos (Folio: ${pago.folio}). No se puede modificar el pago.`,
          "CONFLICT",
        );
      }
    }
    // Legacy idempotency: the same request returns the detail with 200 OK.
    return aDto(fila);
  }

  // Legacy MarcarPagadaSerializer.validate_tipo_pago: existence check (any row).
  // The procedure already validated the tipo_pago pre-transaction (legacy ordering);
  // this re-check inside the tx keeps pagarLiquidacion safe as a shared entry point.
  const tipoPago = await tx.tipoPago.findUnique({
    where: { id: entrada.fkTipoPago },
    select: { id: true },
  });
  if (!tipoPago) throw new RechazoLiquidacion("El tipo de pago no existe.");

  // Folio from the pago sequence (same machinery as pedido pagos; the advisory lock
  // 'pagos_folio' is taken by obtenerSiguienteFolio's caller pattern in pagos.ts —
  // here the liquidaciones lock already serializes, but the folio counter still
  // needs its own lock for cross-module consistency).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pagos_folio'))`;
  const folio = await obtenerSiguienteFolio(tx, "pago", "R");
  const pago = await tx.pago.create({
    data: {
      fkPedido: null,
      fkTipoPago: entrada.fkTipoPago,
      folio,
      monto: fila.montoLiquidar,
      referencia: entrada.referencia?.trim() || null,
      actor: entrada.actor,
    },
  });
  const actualizada = await tx.liquidacion.update({
    where: { id: fila.id },
    data: { fkPagoLiquidacion: pago.id, estado: ESTADO_LIQUIDACION.PAGADA },
    include: inclDetalle,
  });
  await escribirCambios(tx, entrada.actor, [
    { tablaOrigen: "pago", idFila: pago.id, operacion: "insert" },
    { tablaOrigen: "liquidacion", idFila: actualizada.id, operacion: "update" },
  ]);
  await registrarLog(tx, {
    usuarioId: entrada.actor,
    accion: ACCION_LOG.LIQUIDACION_MARCAR_PAGADA,
    entidad: "liquidacion",
    entidadId: actualizada.id,
    ip: entrada.ip,
    dispositivo: entrada.dispositivo,
    detalle: { folio: pago.folio, monto: fila.montoLiquidar.toFixed(2) },
  });
  return aDto(actualizada);
}

// ---- online-lane runner with operationId idempotency (cortes parity) ----

/** Store a rejected verdict (cortes parity): idempotent on concurrent replays. */
async function guardarRechazo(
  db: Database,
  operationId: string,
  actor: string,
  op: string,
  motivo: string,
  codigo: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "INTERNAL_SERVER_ERROR",
): Promise<void> {
  await db.syncOperacion
    .create({
      data: {
        id: operationId,
        fkUsuario: actor,
        coleccion: "liquidaciones",
        docId: crypto.randomUUID(),
        op,
        veredicto: "rechazada",
        respuesta: { motivo, codigo },
      },
    })
    .catch(() => undefined); // a concurrent replay already stored the verdict
}

async function ejecutarOperacion<T>(
  db: Database,
  params: {
    actor: string;
    operationId?: string;
    op: string;
    docId: (resultado: T) => string;
    correr: (tx: Prisma.TransactionClient) => Promise<T>;
    empaquetar: (resultado: T) => Prisma.InputJsonValue;
  },
): Promise<T> {
  const { operationId, actor } = params;
  try {
    return await db.$transaction(async (tx) => {
      if (operationId) {
        const previa = await tx.syncOperacion.findUnique({ where: { id: operationId } });
        if (previa) {
          const respuesta = (previa.respuesta ?? {}) as {
            resultado?: T;
            motivo?: string;
            codigo?: RechazoLiquidacion["codigo"];
          };
          if (previa.veredicto === "aplicada" && respuesta.resultado !== undefined) {
            return respuesta.resultado as T;
          }
          throw new RechazoLiquidacion(
            respuesta.motivo ?? "La operación fue rechazada previamente",
            respuesta.codigo ?? "CONFLICT",
          );
        }
      }
      const resultado = await params.correr(tx);
      if (operationId) {
        await tx.syncOperacion.create({
          data: {
            id: operationId,
            fkUsuario: actor,
            coleccion: "liquidaciones",
            docId: params.docId(resultado),
            op: params.op,
            veredicto: "aplicada",
            respuesta: { resultado: params.empaquetar(resultado) },
          },
        });
      }
      return resultado;
    });
  } catch (error) {
    if (error instanceof RechazoLiquidacion) {
      if (operationId) {
        await guardarRechazo(db, operationId, actor, params.op, error.message, error.codigo);
      }
      throw new TRPCError({ code: error.codigo, message: error.message });
    }
    throw error;
  }
}

// ---- procedures ----

export const liquidacionesRouter = router({
  // Legacy list parity: filters (agricultor, estado, periodo) — Admin sees all.
  listar: protectedProcedure
    .input(
      z
        .object({
          fkAgricultor: ID.optional(),
          estado: z.enum(["pendiente", "pagada", "parcial"]).optional(),
          desde: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          hasta: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, SOLO_ADMIN, MSG_SOLO_ADMIN);
      const filtros: Prisma.LiquidacionWhereInput = {
        ...(input?.fkAgricultor ? { fkAgricultor: input.fkAgricultor } : {}),
        ...(input?.estado ? { estado: input.estado } : {}),
        ...(input?.desde || input?.hasta
          ? {
              OR: [
                ...(input?.desde
                  ? [{ periodoFin: { gte: new Date(`${input.desde}T00:00:00.000Z`) } }]
                  : []),
                ...(input?.hasta
                  ? [{ periodoInicio: { lte: new Date(`${input.hasta}T00:00:00.000Z`) } }]
                  : []),
              ],
            }
          : {}),
      };
      const filas = await ctx.db.liquidacion.findMany({
        where: filtros,
        include: inclDetalle,
        orderBy: { creadoEn: "desc" },
      });
      return filas.map(aDto);
    }),

  // Scoped detail (legacy retrieve parity; Admin-only).
  detalle: protectedProcedure.input(z.object({ id: ID })).query(async ({ input, ctx }) => {
    asegurarRol(ctx.user.rol, SOLO_ADMIN, MSG_SOLO_ADMIN);
    const fila = await ctx.db.liquidacion.findUnique({
      where: { id: input.id },
      include: inclDetalle,
    });
    if (!fila) throw new TRPCError({ code: "NOT_FOUND", message: "Liquidación no encontrada." });
    return aDto(fila);
  }),

  // Legacy POST /calcular/ (Admin-only). operationId (sync §7): a replay with the SAME
  // id returns the stored verdict without re-executing effects.
  calcular: protectedProcedure
    .input(
      z.object({
        agricultor: ID,
        semana: z.number().int().min(SEMANA_MIN).max(SEMANA_MAX),
        anio: z.number().int().min(ANIO_MIN).max(ANIO_MAX),
        operationId: ID.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, SOLO_ADMIN, MSG_SOLO_ADMIN);

      // Legacy CalcularLiquidacionSerializer.validate_agricultor.
      const agricultor = await ctx.db.usuario.findUnique({
        where: { id: input.agricultor },
        include: { rol: { select: { nombre: true } } },
      });
      if (!agricultor) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "El agricultor no existe." });
      }
      if (agricultor.rol.nombre !== ROLE.AGRICULTOR) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "El usuario indicado no tiene rol Agricultor.",
        });
      }
      if (!agricultor.estado) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "El agricultor está inactivo." });
      }

      // ISO round-trip (legacy date.fromisocalendar) — invalid week → clean 400.
      try {
        lunesDeSemanaIso(input.anio, input.semana);
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `La semana ${input.semana} no existe para el año ${input.anio}.`,
        });
      }

      return ejecutarOperacion<LiquidacionDto>(ctx.db, {
        operationId: input.operationId,
        op: "calcular",
        actor: ctx.user.id,
        docId: (r) => r.id,
        correr: (tx) =>
          adjudicarLiquidacion(tx, {
            agricultorId: input.agricultor,
            semana: input.semana,
            anio: input.anio,
            actor: ctx.user.id,
            ip: ctx.ip,
            dispositivo: ctx.dispositivo,
          }),
        empaquetar: (r) => r as unknown as Prisma.InputJsonValue,
      });
    }),

  // Legacy POST /{id}/marcar-pagada/ (Admin-only). operationId replay: same verdict,
  // no effects re-executed; the state-based L8 idempotency stays the primary guard.
  marcarPagada: protectedProcedure
    .input(
      z.object({
        id: ID,
        fkTipoPago: ID,
        referencia: REFERENCIA.optional(),
        operationId: ID.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, SOLO_ADMIN, MSG_SOLO_ADMIN);

      // Legacy MarcarPagadaSerializer.validate_tipo_pago runs BEFORE any row lookup
      // (serializer is_valid first): a missing tipo_pago is a clean 400 even when the
      // liquidación does not exist.
      const tipoPago = await ctx.db.tipoPago.findUnique({
        where: { id: input.fkTipoPago },
        select: { id: true },
      });
      if (!tipoPago) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "El tipo de pago no existe." });
      }

      return ejecutarOperacion<LiquidacionDto>(ctx.db, {
        operationId: input.operationId,
        op: "marcar_pagada",
        actor: ctx.user.id,
        docId: (r) => r.id,
        correr: (tx) =>
          pagarLiquidacion(tx, {
            liquidacionId: input.id,
            fkTipoPago: input.fkTipoPago,
            referencia: input.referencia ?? null,
            actor: ctx.user.id,
            ip: ctx.ip,
            dispositivo: ctx.dispositivo,
          }),
        empaquetar: (r) => r as unknown as Prisma.InputJsonValue,
      });
    }),
});
