import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { ESTADO_PEDIDO } from "@rassa-jala/db";
import type { Prisma } from "@rassa-jala/db";

import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";

// P0 Pagos — Financial core operations (M-13; F-05, F-06, F-07; Q-10 refinement).
// Invariants enforced:
// 1. monto == pedido.total (F-05): server calculates monto from pedido.total, client input is rejected/ignored.
// 2. 1 pago per pedido (F-06): UNIQUE constraint on fk_pedido, validated before insert.
// 3. Monotonic folios under advisory lock (F-07): serialized under pg_advisory_xact_lock(hashtext('pagos_folio')).
// 4. In one tx: verify pedido is 'pendiente' -> insert Pago -> insert Recibo with snapshot JSON ->
//    update pedido state to 'confirmado' with version CAS -> append HistorialEstadoPedido -> write sync_cambio outbox.
// 5. Entregado advance: transitions 'confirmado' -> 'entregado' with version CAS + historial + outbox.
// 6. Recibo query: authorized for Admin, assigned Vendedor, or owning Cliente / family member.

const ID = z.string().uuid();
const REFERENCIA = z.string().max(200);

type OperacionOutbox = "insert" | "update";

async function escribirCambios(
  tx: Prisma.TransactionClient,
  actor: string,
  cambios: Array<{ tablaOrigen: string; idFila: string; operacion: OperacionOutbox }>,
): Promise<void> {
  if (cambios.length === 0) return;
  await tx.syncCambio.createMany({ data: cambios.map((c) => ({ ...c, actor })) });
}

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

function asegurarRol(rol: Role, permitidos: Role[], mensaje: string): void {
  if (!permitidos.includes(rol)) {
    throw new TRPCError({ code: "FORBIDDEN", message: mensaje });
  }
}

function nombrePersona(persona: { nombre: string; apellidoPaterno: string } | null): string | null {
  return persona ? `${persona.nombre} ${persona.apellidoPaterno}` : null;
}

async function obtenerSiguienteFolio(
  tx: Prisma.TransactionClient,
  nombre: "pago" | "recibo",
  prefijo: string,
): Promise<string> {
  const row = await tx.folioSecuencia.upsert({
    where: { nombre },
    update: { siguiente: { increment: 1 } },
    create: { nombre, siguiente: 2 },
  });
  const numero = row.siguiente - 1;
  return `${prefijo}-${String(numero).padStart(6, "0")}`;
}

export const pagosRouter = router({
  tiposPago: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.tipoPago.findMany({
      where: { estado: true },
      select: { id: true, nombre: true },
      orderBy: { creadoEn: "asc" },
    });
  }),

  registrarPago: protectedProcedure
    .input(
      z.object({
        fkPedido: ID,
        fkTipoPago: ID,
        referencia: REFERENCIA.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarRol(
        ctx.user.rol,
        [ROLE.ADMIN, ROLE.VENDEDOR],
        "Solo Vendedor o Admin pueden registrar pagos",
      );

      return ctx.db.$transaction(async (tx) => {
        // Serialize folio generation and payment operations
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pagos_folio'))`;
        await tx.$executeRaw`SELECT id FROM pedido_cabecera WHERE id = ${input.fkPedido}::uuid FOR UPDATE`;

        const pedido = await tx.pedidoCabecera.findUnique({
          where: { id: input.fkPedido },
          include: {
            estadoPedido: { select: { nombre: true } },
            detalles: true,
            cliente: {
              select: {
                id: true,
                correo: true,
                persona: { select: { nombre: true, apellidoPaterno: true } },
              },
            },
            vendedor: {
              select: {
                id: true,
                correo: true,
                persona: { select: { nombre: true, apellidoPaterno: true } },
              },
            },
            pago: true,
          },
        });

        if (!pedido) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Pedido no encontrado" });
        }

        if (pedido.pago) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "El pedido ya tiene un pago registrado",
          });
        }

        if (pedido.estadoPedido.nombre !== ESTADO_PEDIDO.PENDIENTE) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Solo se puede registrar pago en pedidos pendientes",
          });
        }

        if (ctx.user.rol === ROLE.VENDEDOR && pedido.fkVendedor !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "El pedido no está asignado a tu usuario",
          });
        }

        const tipoPago = await tx.tipoPago.findUnique({
          where: { id: input.fkTipoPago },
          select: { id: true, nombre: true, estado: true },
        });

        if (!tipoPago?.estado) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Tipo de pago no válido o inactivo",
          });
        }

        const folioPago = await obtenerSiguienteFolio(tx, "pago", "R");
        const folioRecibo = await obtenerSiguienteFolio(tx, "recibo", "REC");

        // F-05: Server derives monto from pedido.total (client monto input is killed)
        const nuevoPago = await tx.pago.create({
          data: {
            fkPedido: pedido.id,
            fkTipoPago: tipoPago.id,
            folio: folioPago,
            monto: pedido.total,
            referencia: input.referencia?.trim() || null,
            actor: ctx.user.id,
          },
        });

        const snapshotRecibo = {
          folioRecibo,
          folioPago,
          tipoPago: tipoPago.nombre,
          referencia: input.referencia?.trim() || null,
          monto: pedido.total.toFixed(2),
          subtotal: pedido.subtotal.toFixed(2),
          iva: pedido.iva.toFixed(2),
          pedidoId: pedido.id,
          origen: pedido.origen,
          notas: pedido.notas,
          cliente: pedido.cliente
            ? {
                id: pedido.cliente.id,
                correo: pedido.cliente.correo,
                nombre: nombrePersona(pedido.cliente.persona),
              }
            : {
                nombre: pedido.clienteNombre,
                telefono: pedido.clienteTelefono,
              },
          vendedor: pedido.vendedor
            ? {
                id: pedido.vendedor.id,
                correo: pedido.vendedor.correo,
                nombre: nombrePersona(pedido.vendedor.persona),
              }
            : null,
          items: pedido.detalles.map((d) => ({
            id: d.id,
            fkProductoSemanal: d.fkProductoSemanal,
            nombreProducto: d.nombreProducto,
            cantidad: d.cantidad,
            precioUnitario: d.precioUnitario.toFixed(2),
            importe: d.importe.toFixed(2),
          })),
          emitidoEn: new Date().toISOString(),
        };

        const nuevoRecibo = await tx.recibo.create({
          data: {
            fkPago: nuevoPago.id,
            folio: folioRecibo,
            datos: snapshotRecibo,
          },
        });

        const idConfirmado = await idEstado(tx, ESTADO_PEDIDO.CONFIRMADO);
        const updated = await tx.pedidoCabecera.updateMany({
          where: { id: pedido.id, version: pedido.version },
          data: { fkEstado: idConfirmado, version: { increment: 1 } },
        });

        if (updated.count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "El pedido fue modificado concurrentemente",
          });
        }

        const historial = await tx.historialEstadoPedido.create({
          data: {
            fkPedido: pedido.id,
            fkEstado: idConfirmado,
            actor: ctx.user.id,
          },
        });

        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "pago", idFila: nuevoPago.id, operacion: "insert" },
          { tablaOrigen: "recibo", idFila: nuevoRecibo.id, operacion: "insert" },
          { tablaOrigen: "pedido_cabecera", idFila: pedido.id, operacion: "update" },
          { tablaOrigen: "historial_estado_pedido", idFila: historial.id, operacion: "insert" },
        ]);

        return {
          pagoId: nuevoPago.id,
          folioPago,
          reciboId: nuevoRecibo.id,
          folioRecibo,
          monto: pedido.total.toFixed(2),
          estado: ESTADO_PEDIDO.CONFIRMADO,
        };
      });
    }),

  marcarEntregado: protectedProcedure
    .input(
      z.object({
        fkPedido: ID,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarRol(
        ctx.user.rol,
        [ROLE.ADMIN, ROLE.VENDEDOR],
        "Solo Vendedor o Admin pueden marcar entrega",
      );

      return ctx.db.$transaction(async (tx) => {
        const pedido = await tx.pedidoCabecera.findUnique({
          where: { id: input.fkPedido },
          include: {
            estadoPedido: { select: { nombre: true } },
          },
        });

        if (!pedido) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Pedido no encontrado" });
        }

        if (ctx.user.rol === ROLE.VENDEDOR && pedido.fkVendedor !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "El pedido no está asignado a tu usuario",
          });
        }

        if (pedido.estadoPedido.nombre !== ESTADO_PEDIDO.CONFIRMADO) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Solo se puede marcar como entregado un pedido en estado confirmado",
          });
        }

        const idEntregado = await idEstado(tx, ESTADO_PEDIDO.ENTREGADO);
        const updated = await tx.pedidoCabecera.updateMany({
          where: { id: pedido.id, version: pedido.version },
          data: { fkEstado: idEntregado, version: { increment: 1 } },
        });

        if (updated.count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "El pedido fue modificado concurrentemente",
          });
        }

        const historial = await tx.historialEstadoPedido.create({
          data: {
            fkPedido: pedido.id,
            fkEstado: idEntregado,
            actor: ctx.user.id,
          },
        });

        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "pedido_cabecera", idFila: pedido.id, operacion: "update" },
          { tablaOrigen: "historial_estado_pedido", idFila: historial.id, operacion: "insert" },
        ]);

        return {
          success: true,
          pedidoId: pedido.id,
          estado: ESTADO_PEDIDO.ENTREGADO,
        };
      });
    }),

  obtenerRecibo: protectedProcedure
    .input(
      z.object({
        fkPedido: ID,
      }),
    )
    .query(async ({ input, ctx }) => {
      const pedido = await ctx.db.pedidoCabecera.findUnique({
        where: { id: input.fkPedido },
        include: {
          pago: {
            include: {
              tipoPago: { select: { nombre: true } },
              recibo: true,
            },
          },
        },
      });

      if (!pedido?.pago?.recibo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Recibo no encontrado para este pedido",
        });
      }

      // Authorization check: Admin, assigned Vendedor, or owning Cliente/family member
      if (ctx.user.rol === ROLE.ADMIN) {
        // Admin has access to all receipts
      } else if (ctx.user.rol === ROLE.VENDEDOR) {
        if (pedido.fkVendedor !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No tienes permiso para ver este recibo",
          });
        }
      } else if (ctx.user.rol === ROLE.CLIENTE) {
        if (pedido.fkCliente === ctx.user.id) {
          // Direct owner
        } else if (pedido.fkCliente) {
          // Family member check
          const miFamilia = await ctx.db.familiaUsuario.findFirst({
            where: { fkUsuario: ctx.user.id, estado: true },
            select: { fkFamilia: true },
          });
          if (miFamilia) {
            const mismoGrupo = await ctx.db.familiaUsuario.findFirst({
              where: {
                fkFamilia: miFamilia.fkFamilia,
                fkUsuario: pedido.fkCliente,
                estado: true,
              },
            });
            if (!mismoGrupo) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message: "No tienes permiso para ver este recibo",
              });
            }
          } else {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "No tienes permiso para ver este recibo",
            });
          }
        } else {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No tienes permiso para ver este recibo",
          });
        }
      } else {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No tienes permiso para ver este recibo",
        });
      }

      return {
        recibo: {
          id: pedido.pago.recibo.id,
          folio: pedido.pago.recibo.folio,
          emitidoEn: pedido.pago.recibo.emitidoEn.toISOString(),
          datos: pedido.pago.recibo.datos,
        },
        pago: {
          id: pedido.pago.id,
          folio: pedido.pago.folio,
          monto: pedido.pago.monto.toFixed(2),
          referencia: pedido.pago.referencia,
          tipoPago: pedido.pago.tipoPago.nombre,
          creadoEn: pedido.pago.creadoEn.toISOString(),
        },
      };
    }),
});
