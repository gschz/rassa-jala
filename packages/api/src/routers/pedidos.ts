import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { ESTADOS_CANCELABLES_PEDIDO, ESTADO_PEDIDO, ORIGEN_PEDIDO } from "@rassa-jala/db";
import type { Database, Prisma } from "@rassa-jala/db";

import { aCentavos, aDecimal, importeDe, sumaCentavos, totalDe, ivaDe } from "../money";
import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";

// P0 Pedidos — the financial heart (docs/scope.md §3.1 CORREGIR; docs/database.md §3.4
// rows, §6.2 `pedidos` S2 row, M-2/M-12; docs/scope.md §3.2 Q-06/Q-10/Q-14).
//
// ONE adjudication entry point (adjudicarPedido) serves checkout (client online), the
// offline push (sync.ts) and pedidoPresencial (seller in-person). Inside ONE transaction:
// advisory lock → item validation → money snapshots (money.ts, client totals ignored) →
// credit (Q-10) → stock (atomic conditional decrement) → order + details + historial +
// outbox rows. Domain rejections throw the `Rechazo` sentinel so the transaction rolls
// back EVERYTHING (including any partial stock decrements of earlier lines) and callers
// map it to their lane's failure shape (tRPC error / push verdict).
//
// Mutation pattern is the same as publicaciones.ts/familias.ts (M-1a outbox in the same
// tx, SP-2 version CAS via updateMany, role checks re-read the DB role).

const ID = z.uuid();
const VERSION = z.number().int().positive();
const NOTAS = z.string().max(500);
const CANTIDAD = z.number().int().positive();
const NOMBRE_FISICO = z.string().min(1).max(150);
const TELEFONO = z
  .string()
  .min(7)
  .max(20)
  .regex(/^[\d\s+()-]+$/);

const ITEMS = z
  .array(z.object({ fkProductoSemanal: ID, cantidad: CANTIDAD }))
  .min(1)
  .max(50);

// ---- DTO shapes (money as string, dates ISO 8601 — database.md §6.3) ----

interface DetalleDto {
  id: string;
  fkPedido: string;
  fkProductoSemanal: string;
  nombreProducto: string;
  cantidad: number;
  precioUnitario: string;
  importe: string;
  version: number;
}

interface HistorialDto {
  id: string;
  estadoNombre: string;
  fecha: string;
  actor: string | null;
}

interface PedidoDto {
  id: string;
  fkCliente: string | null;
  fkVendedor: string | null;
  estadoNombre: string;
  estado: boolean;
  subtotal: string;
  iva: string;
  total: string;
  origen: string;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  notas: string | null;
  version: number;
  actualizadoEn: string;
  detalles: DetalleDto[];
}

type FilaPedido = Awaited<ReturnType<Database["pedidoCabecera"]["findMany"]>>[number];
type FilaDetalle = Awaited<ReturnType<Database["detallePedido"]["findMany"]>>[number];

function aDtoDetalle(fila: FilaDetalle): DetalleDto {
  return {
    id: fila.id,
    fkPedido: fila.fkPedido,
    fkProductoSemanal: fila.fkProductoSemanal,
    nombreProducto: fila.nombreProducto,
    cantidad: fila.cantidad,
    precioUnitario: fila.precioUnitario.toFixed(2),
    importe: fila.importe.toFixed(2),
    version: fila.version,
  };
}

function aDtoPedido(
  fila: FilaPedido & { detalles: FilaDetalle[]; estadoPedido: { nombre: string } },
): PedidoDto {
  return {
    id: fila.id,
    fkCliente: fila.fkCliente,
    fkVendedor: fila.fkVendedor,
    estadoNombre: fila.estadoPedido.nombre,
    estado: fila.estado,
    subtotal: fila.subtotal.toFixed(2),
    iva: fila.iva.toFixed(2),
    total: fila.total.toFixed(2),
    origen: fila.origen,
    clienteNombre: fila.clienteNombre,
    clienteTelefono: fila.clienteTelefono,
    notas: fila.notas,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    detalles: fila.detalles.map(aDtoDetalle),
  };
}

function aDtoHistorial(fila: {
  id: string;
  estado: { nombre: string };
  fecha: Date;
  actor: string | null;
}): HistorialDto {
  return {
    id: fila.id,
    estadoNombre: fila.estado.nombre,
    fecha: fila.fecha.toISOString(),
    actor: fila.actor,
  };
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

// State-catalog lookups (seed guarantees the rows; a missing one is an internal failure).
async function idEstado(tx: Prisma.TransactionClient, nombre: string): Promise<string> {
  const fila = await tx.estadoPedido.findUnique({ where: { nombre }, select: { id: true } });
  if (!fila) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "El catálogo de estados de pedido no está sembrado",
    });
  }
  return fila.id;
}

/** Q-06 claim lane / Q-10 lane boundary enforcement. */
function asegurarRol(rol: Role, permitidos: Role[], mensaje: string): void {
  if (!permitidos.includes(rol)) {
    throw new TRPCError({ code: "FORBIDDEN", message: mensaje });
  }
}

// ---- THE single adjudication entry point ----

/**
 * Domain rejection sentinel: thrown INSIDE the adjudication transaction so every effect
 * (any partial stock decrement of an earlier line) rolls back; callers catch it OUTSIDE
 * and map it to their lane's failure shape. Nothing needs manual restore — the tx abort
 * is the restore.
 */
export class Rechazo extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "Rechazo";
  }
}

export type EntradaAdjudicacion = {
  fkCliente: string | null;
  fkVendedor: string | null;
  origen: (typeof ORIGEN_PEDIDO)[keyof typeof ORIGEN_PEDIDO];
  clienteNombre: string | null;
  clienteTelefono: string | null;
  notas: string | null;
  items: Array<{ fkProductoSemanal: string; cantidad: number }>;
  /** Authenticated user driving the mutation (outbox actor + historial actor). */
  actor: string;
  /** Client-supplied doc id (offline push path); server UUID when absent. */
  docId?: string;
};

/**
 * Q-06/Q-10/Q-14 central adjudication — used by checkout, pedidoPresencial and the
 * pedidos push (sync.ts). Steps inside ONE tx:
 *  a. advisory lock `pg_advisory_xact_lock(hashtext('pedidos_adjudicacion'))` — serializes
 *     the stock+credit decision across all creation lanes;
 *  b. every producto_semanal: exists + estado 'activo' + its publicacion 'publicado' +
 *     maestro activo; no duplicate items (legacy parity);
 *  c. credit — ONLY when fkCliente is set: owner = the client's active family (family
 *     limit) else the individual limite_credito; none → reject. Usage = Σ totals of the
 *     owner's orders with estado != 'cancelado' (the pending-payment refinement is the
 *     pagos module's job, documented in M-12);
 *  d. stock — per item an atomic conditional decrement
 *     `updateMany({ id, stock: { gte: cantidad } }, { stock: { decrement } })`; 0 rows →
 *     reject (whole order atomic: the tx rolls back any earlier line);
 *  e. money snapshots via money.ts — client-computed totals are NEVER trusted;
 *  f. insert pedido_cabecera (estado = seeded 'pendiente') + detalles + historial row +
 *     outbox rows (order, each detail, each touched producto_semanal) — one tx.
 *
 * Throws Rechazo(motivo) on domain failure; returns the created order DTO.
 */
export async function adjudicarPedido(
  tx: Prisma.TransactionClient,
  entrada: EntradaAdjudicacion,
): Promise<PedidoDto> {
  // a. Serialize the stock+credit decision (F-07 primitive: app-level advisory lock).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pedidos_adjudicacion'))`;

  // b. Items: duplicates first (legacy parity), then per-item validation.
  const ids = entrada.items.map((i) => i.fkProductoSemanal);
  if (new Set(ids).size !== ids.length) {
    throw new Rechazo("No se permiten productos duplicados en un mismo pedido");
  }
  const semanales = await tx.productoSemanal.findMany({
    where: { id: { in: ids } },
    include: {
      producto: { select: { nombre: true, estado: true } },
      publicacion: { select: { estado: true } },
    },
  });
  const semanalPorId = new Map(semanales.map((s) => [s.id, s] as const));
  for (const item of entrada.items) {
    const semanal = semanalPorId.get(item.fkProductoSemanal);
    if (!semanal) {
      throw new Rechazo("Producto semanal no encontrado");
    }
    const nombre = semanal.producto.nombre;
    if (semanal.estado !== "activo") {
      throw new Rechazo(`El producto '${nombre}' ya no está activo`);
    }
    if (semanal.publicacion.estado !== "publicado") {
      throw new Rechazo(`La publicación del producto '${nombre}' ya no está disponible`);
    }
    if (!semanal.producto.estado) {
      throw new Rechazo(`El producto del catálogo '${nombre}' ya no está activo`);
    }
  }

  // e. Money (Q-14): decimal string → integer cents → exact integer math.
  const importes = entrada.items.map((item) => {
    const semanal = semanalPorId.get(item.fkProductoSemanal);
    if (!semanal) throw new Rechazo("Producto semanal no encontrado");
    const precioCents = aCentavos(semanal.precio.toFixed(2));
    return importeDe(precioCents, item.cantidad);
  });
  const subtotalCents = sumaCentavos(importes);
  const ivaCents = ivaDe(subtotalCents);
  const totalCents = totalDe(subtotalCents, ivaCents);

  // c. Credit (Q-10) — only account-bound orders consume credit; clientes físicos
  //    (fk_cliente NULL) never do. Owner: active family → family limit; else individual.
  if (entrada.fkCliente !== null) {
    const membresia = await tx.familiaUsuario.findFirst({
      where: { fkUsuario: entrada.fkCliente, estado: true },
      select: { fkFamilia: true },
    });
    let consumidores: string[];
    let limite: { monto: Prisma.Decimal } | null;
    if (membresia) {
      const miembros = await tx.familiaUsuario.findMany({
        where: { fkFamilia: membresia.fkFamilia, estado: true },
        select: { fkUsuario: true },
      });
      consumidores = miembros.map((m) => m.fkUsuario);
      limite = await tx.limiteCredito.findFirst({
        where: { fkFamilia: membresia.fkFamilia, estado: true },
        select: { monto: true },
      });
    } else {
      consumidores = [entrada.fkCliente];
      limite = await tx.limiteCredito.findFirst({
        where: { fkUsuario: entrada.fkCliente, estado: true },
        select: { monto: true },
      });
    }
    if (!limite) {
      throw new Rechazo("No tiene límite de crédito asignado");
    }
    const usados = await tx.pedidoCabecera.findMany({
      where: { fkCliente: { in: consumidores } },
      select: { total: true, estadoPedido: { select: { nombre: true } } },
    });
    const usoCents = sumaCentavos(
      usados
        .filter((p) => p.estadoPedido.nombre !== ESTADO_PEDIDO.CANCELADO)
        .map((p) => aCentavos(p.total.toFixed(2))),
    );
    const limiteCents = aCentavos(limite.monto.toFixed(2));
    if (usoCents + totalCents > limiteCents) {
      throw new Rechazo(
        `Límite de crédito insuficiente (usado ${aDecimal(usoCents)} de ${aDecimal(limiteCents)})`,
      );
    }
  }

  // d. Stock — atomic conditional decrement; 0 rows means insufficient (or vanished).
  for (const item of entrada.items) {
    const semanal = semanalPorId.get(item.fkProductoSemanal);
    if (!semanal) throw new Rechazo("Producto semanal no encontrado");
    const aplicadas = await tx.productoSemanal.updateMany({
      where: { id: item.fkProductoSemanal, stock: { gte: item.cantidad } },
      data: { stock: { decrement: item.cantidad }, version: { increment: 1 } },
    });
    if (aplicadas.count === 0) {
      throw new Rechazo(`Stock insuficiente para '${semanal.producto.nombre}'`);
    }
  }

  // f. Order + details + historial + outbox — ONE tx.
  const idPendiente = await idEstado(tx, ESTADO_PEDIDO.PENDIENTE);
  const pedido = await tx.pedidoCabecera.create({
    data: {
      ...(entrada.docId ? { id: entrada.docId } : {}),
      fkCliente: entrada.fkCliente,
      fkVendedor: entrada.fkVendedor,
      fkEstado: idPendiente,
      subtotal: aDecimal(subtotalCents),
      iva: aDecimal(ivaCents),
      total: aDecimal(totalCents),
      origen: entrada.origen,
      clienteNombre: entrada.clienteNombre,
      clienteTelefono: entrada.clienteTelefono,
      notas: entrada.notas,
    },
  });
  const filasDetalle: FilaDetalle[] = [];
  for (const item of entrada.items) {
    const semanal = semanalPorId.get(item.fkProductoSemanal);
    if (!semanal) throw new Rechazo("Producto semanal no encontrado");
    const precioCents = aCentavos(semanal.precio.toFixed(2));
    filasDetalle.push(
      await tx.detallePedido.create({
        data: {
          fkPedido: pedido.id,
          fkProductoSemanal: item.fkProductoSemanal,
          nombreProducto: semanal.producto.nombre,
          cantidad: item.cantidad,
          precioUnitario: aDecimal(precioCents),
          importe: aDecimal(importeDe(precioCents, item.cantidad)),
        },
      }),
    );
  }
  await tx.historialEstadoPedido.create({
    data: { fkPedido: pedido.id, fkEstado: idPendiente, actor: entrada.actor },
  });
  await escribirCambios(tx, entrada.actor, [
    { tablaOrigen: "pedido_cabecera", idFila: pedido.id, operacion: "insert" },
    ...filasDetalle.map((d) => ({
      tablaOrigen: "detalle_pedido",
      idFila: d.id,
      operacion: "insert" as const,
    })),
    ...entrada.items.map((item) => ({
      tablaOrigen: "producto_semanal",
      idFila: item.fkProductoSemanal,
      operacion: "update" as const,
    })),
  ]);
  return aDtoPedido({
    ...pedido,
    estadoPedido: { nombre: ESTADO_PEDIDO.PENDIENTE },
    detalles: filasDetalle,
  });
}

// ---- procedures ----

export const pedidosRouter = router({
  // Client online checkout: fk_cliente = authenticated identity, origen digital.
  // operationId (sync doc §7): optional idempotency key — a retry with the SAME id
  // returns the stored order without re-executing (stock/credit effects).
  checkout: protectedProcedure
    .input(z.object({ items: ITEMS, notas: NOTAS.optional(), operationId: ID.optional() }))
    .mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, [ROLE.CLIENTE], "Solo los clientes pueden crear pedidos");
      return ejecutarAdjudicacion(ctx.db, {
        fkCliente: ctx.user.id,
        fkVendedor: null,
        origen: ORIGEN_PEDIDO.DIGITAL,
        clienteNombre: null,
        clienteTelefono: null,
        notas: input.notas ?? null,
        items: input.items,
        actor: ctx.user.id,
        operationId: input.operationId,
      });
    }),

  // In-person order (Q-06): seller-only for an account-less person — fk_cliente NULL
  // (no credit), fk_vendedor auto-assigned to the creating seller.
  pedidoPresencial: protectedProcedure
    .input(
      z.object({
        clienteNombre: NOMBRE_FISICO,
        clienteTelefono: TELEFONO.optional(),
        items: ITEMS,
        notas: NOTAS.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarRol(
        ctx.user.rol,
        [ROLE.VENDEDOR],
        "Solo los vendedores registran pedidos presenciales",
      );
      return ejecutarAdjudicacion(ctx.db, {
        fkCliente: null,
        fkVendedor: ctx.user.id,
        origen: ORIGEN_PEDIDO.PRESENCIAL,
        clienteNombre: input.clienteNombre,
        clienteTelefono: input.clienteTelefono ?? null,
        notas: input.notas ?? null,
        items: input.items,
        actor: ctx.user.id,
      });
    }),

  // Q-06 atomic claim: exactly ONE seller wins; the loser gets 409. The conditional
  // updateMany (fkVendedor NULL + still pendiente) IS the mutex.
  claimar: protectedProcedure.input(z.object({ pedidoId: ID })).mutation(async ({ input, ctx }) => {
    asegurarRol(ctx.user.rol, [ROLE.VENDEDOR], "Solo los vendedores pueden reclamar pedidos");
    return ctx.db.$transaction(async (tx) => {
      const idPendiente = await idEstado(tx, ESTADO_PEDIDO.PENDIENTE);
      const aplicadas = await tx.pedidoCabecera.updateMany({
        where: { id: input.pedidoId, fkVendedor: null, fkEstado: idPendiente, estado: true },
        data: { fkVendedor: ctx.user.id, version: { increment: 1 } },
      });
      if (aplicadas.count === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "El pedido ya fue reclamado por otro vendedor o ya no está pendiente",
        });
      }
      await escribirCambios(tx, ctx.user.id, [
        { tablaOrigen: "pedido_cabecera", idFila: input.pedidoId, operacion: "update" },
      ]);
      const fila = await tx.pedidoCabecera.findUniqueOrThrow({
        where: { id: input.pedidoId },
        include: { detalles: true, estadoPedido: { select: { nombre: true } } },
      });
      return aDtoPedido(fila);
    });
  }),

  // Q-06: only Admin reassigns; the target must be an ACTIVE Vendedor.
  reasignar: protectedProcedure
    .input(z.object({ pedidoId: ID, fkVendedor: ID }))
    .mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, [ROLE.ADMIN], "Solo el rol Admin puede reasignar pedidos");
      return ctx.db.$transaction(async (tx) => {
        const vendedor = await tx.usuario.findUnique({
          where: { id: input.fkVendedor },
          select: { estado: true, rol: { select: { nombre: true } } },
        });
        if (!vendedor?.estado || vendedor.rol.nombre !== ROLE.VENDEDOR) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "El vendedor indicado no existe o está inactivo",
          });
        }
        const aplicadas = await tx.pedidoCabecera.updateMany({
          where: { id: input.pedidoId, estado: true },
          data: { fkVendedor: input.fkVendedor, version: { increment: 1 } },
        });
        if (aplicadas.count === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Pedido no encontrado" });
        }
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "pedido_cabecera", idFila: input.pedidoId, operacion: "update" },
        ]);
        const fila = await tx.pedidoCabecera.findUniqueOrThrow({
          where: { id: input.pedidoId },
          include: { detalles: true, estadoPedido: { select: { nombre: true } } },
        });
        return aDtoPedido(fila);
      });
    }),

  // Cancel (legacy ESTADOS_CANCELABLES parity + module relaxation): client cancels its
  // OWN order while 'pendiente'; seller cancels ASSIGNED orders in cancelable states;
  // Admin any cancelable. Restores stock (+cantidad per line), appends historial, outbox.
  cancelar: protectedProcedure
    .input(z.object({ pedidoId: ID, version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      return ctx.db.$transaction(async (tx) => {
        const fila = await tx.pedidoCabecera.findUnique({
          where: { id: input.pedidoId },
          include: { detalles: true, estadoPedido: { select: { nombre: true } } },
        });
        if (!fila?.estado) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Pedido no encontrado" });
        }
        const estadoActual = fila.estadoPedido.nombre;
        if (!ESTADOS_CANCELABLES_PEDIDO.includes(estadoActual as never)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `No se puede cancelar un pedido en estado '${estadoActual}'`,
          });
        }
        if (ctx.user.rol === ROLE.CLIENTE) {
          if (fila.fkCliente !== ctx.user.id || estadoActual !== ESTADO_PEDIDO.PENDIENTE) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Solo puedes cancelar tus propios pedidos mientras están pendientes",
            });
          }
        } else if (ctx.user.rol === ROLE.VENDEDOR) {
          if (fila.fkVendedor !== ctx.user.id) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "El pedido no está asignado a ti",
            });
          }
        } else if (ctx.user.rol !== ROLE.ADMIN) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Rol sin permiso sobre pedidos" });
        }
        const idCancelado = await idEstado(tx, ESTADO_PEDIDO.CANCELADO);
        const aplicadas = await tx.pedidoCabecera.updateMany({
          where: { id: fila.id, version: input.version },
          data: { fkEstado: idCancelado, version: { increment: 1 } },
        });
        if (aplicadas.count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "El pedido cambió en el servidor; reintenta con su versión actual",
          });
        }
        // Stock restore (+cantidad per line); each decrement emits its own outbox row.
        await Promise.all(
          fila.detalles.map(async (detalle) => {
            await tx.productoSemanal.updateMany({
              where: { id: detalle.fkProductoSemanal },
              data: { stock: { increment: detalle.cantidad }, version: { increment: 1 } },
            });
          }),
        );
        await tx.historialEstadoPedido.create({
          data: { fkPedido: fila.id, fkEstado: idCancelado, actor: ctx.user.id },
        });
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "pedido_cabecera", idFila: fila.id, operacion: "update" },
          ...fila.detalles.map((d) => ({
            tablaOrigen: "producto_semanal",
            idFila: d.fkProductoSemanal,
            operacion: "update" as const,
          })),
        ]);
        const actualizado = await tx.pedidoCabecera.findUniqueOrThrow({
          where: { id: fila.id },
          include: { detalles: true, estadoPedido: { select: { nombre: true } } },
        });
        return aDtoPedido(actualizado);
      });
    }),

  // Client: own; Vendedor: assigned; Admin: all.
  misPedidos: protectedProcedure.query(async ({ ctx }) => {
    const where =
      ctx.user.rol === ROLE.ADMIN
        ? {}
        : ctx.user.rol === ROLE.VENDEDOR
          ? { fkVendedor: ctx.user.id }
          : { fkCliente: ctx.user.id };
    const filas = await ctx.db.pedidoCabecera.findMany({
      where,
      orderBy: { creadoEn: "desc" },
      include: { detalles: true, estadoPedido: { select: { nombre: true } } },
    });
    return filas.map(aDtoPedido);
  }),

  // Q-06 available lane: unclaimed + still pendiente (read-only listing; claiming is the
  // atomic procedure above).
  disponibles: protectedProcedure.query(async ({ ctx }) => {
    asegurarRol(ctx.user.rol, [ROLE.VENDEDOR], "Solo los vendedores consultan pedidos disponibles");
    const idPendiente = await idEstado(ctx.db, ESTADO_PEDIDO.PENDIENTE);
    const filas = await ctx.db.pedidoCabecera.findMany({
      where: { fkVendedor: null, fkEstado: idPendiente, estado: true },
      orderBy: { creadoEn: "asc" },
      include: { detalles: true, estadoPedido: { select: { nombre: true } } },
    });
    return filas.map(aDtoPedido);
  }),

  // Scoped detail + historial (legacy `/pedidos/{id}/historial` parity, §3.6 audit).
  detalle: protectedProcedure.input(z.object({ id: ID })).query(async ({ input, ctx }) => {
    const fila = await ctx.db.pedidoCabecera.findUnique({
      where: { id: input.id },
      include: { detalles: true, estadoPedido: { select: { nombre: true } } },
    });
    if (!fila) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Pedido no encontrado" });
    }
    if (!visiblePara(ctx.user.rol, ctx.user.id, fila.fkCliente, fila.fkVendedor)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "El pedido no es tuyo" });
    }
    const historial = await ctx.db.historialEstadoPedido.findMany({
      where: { fkPedido: fila.id },
      orderBy: { fecha: "asc" },
      include: { estado: { select: { nombre: true } } },
    });
    return { ...aDtoPedido(fila), historial: historial.map(aDtoHistorial) };
  }),

  // Admin overview with filters (legacy `GET /pedidos/?estado=` parity).
  list: protectedProcedure
    .input(
      z
        .object({
          estado: z.string().max(30).optional(),
          origen: z.enum([ORIGEN_PEDIDO.DIGITAL, ORIGEN_PEDIDO.PRESENCIAL]).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, [ROLE.ADMIN], "Solo el rol Admin lista todos los pedidos");
      const filas = await ctx.db.pedidoCabecera.findMany({
        where: {
          ...(input?.origen ? { origen: input.origen } : {}),
          ...(input?.estado ? { estadoPedido: { nombre: input.estado } } : {}),
        },
        orderBy: { creadoEn: "desc" },
        include: {
          detalles: true,
          estadoPedido: { select: { nombre: true } },
          cliente: { include: { persona: true } },
          vendedor: { include: { persona: true } },
        },
      });
      return filas.map((fila) => ({
        ...aDtoPedido(fila),
        clienteDisplay: fila.clienteNombre ?? nombrePersona(fila.cliente?.persona ?? null),
        vendedorDisplay: nombrePersona(fila.vendedor?.persona ?? null),
      }));
    }),
});

// ---- helpers used by the procedures above and by sync.ts ----

/** Role-based row visibility (§6.2 `pedidos` scoping: cliente propios, vendedor
 * asignados, admin todos). Agricultores no participan en pedidos. */
export function visiblePara(
  rol: Role,
  idUsuario: string,
  fkCliente: string | null,
  fkVendedor: string | null,
): boolean {
  if (rol === ROLE.ADMIN) return true;
  if (rol === ROLE.VENDEDOR) return fkVendedor === idUsuario;
  if (rol === ROLE.CLIENTE) return fkCliente === idUsuario;
  return false;
}

function nombrePersona(persona: { nombre: string; apellidoPaterno: string } | null): string | null {
  return persona ? `${persona.nombre} ${persona.apellidoPaterno}` : null;
}

/**
 * Online lane runner: opens the adjudication tx, maps Rechazo → 400 BAD_REQUEST with the
 * exact server motivo, and (when an operationId rides along) stores the verdict for
 * idempotent retries (sync doc §7 — replay returns the stored order, no double effects).
 */
async function ejecutarAdjudicacion(
  db: Database,
  entrada: EntradaAdjudicacion & { operationId?: string },
): Promise<PedidoDto> {
  const { operationId, ...cuerpo } = entrada;
  try {
    return await db.$transaction(async (tx) => {
      if (operationId) {
        const previa = await tx.syncOperacion.findUnique({ where: { id: operationId } });
        if (previa) {
          // §7 replay: the stored verdict is authoritative — aplicada returns the stored
          // order; rechazada re-raises its motivo (no effects re-executed either way).
          const respuesta = (previa.respuesta ?? {}) as {
            pedido?: PedidoDto;
            motivo?: string;
          };
          if (previa.veredicto === "aplicada" && respuesta.pedido) return respuesta.pedido;
          throw new Rechazo(respuesta.motivo ?? "La operación fue rechazada previamente");
        }
      }
      const pedido = await adjudicarPedido(tx, cuerpo);
      if (operationId) {
        await tx.syncOperacion.create({
          data: {
            id: operationId,
            fkUsuario: entrada.actor,
            coleccion: "pedidos",
            docId: pedido.id,
            op: "create",
            veredicto: "aplicada",
            respuesta: { pedido } as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return pedido;
    });
  } catch (error) {
    if (error instanceof Rechazo) {
      if (operationId) {
        await db.syncOperacion
          .create({
            data: {
              id: operationId,
              fkUsuario: entrada.actor,
              coleccion: "pedidos",
              docId: entrada.docId ?? crypto.randomUUID(),
              op: "create",
              veredicto: "rechazada",
              respuesta: { motivo: error.message } as unknown as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined); // a concurrent replay already stored the verdict
      }
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    throw error;
  }
}
