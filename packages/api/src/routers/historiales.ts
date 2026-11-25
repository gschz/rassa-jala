import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  ESTADO_PEDIDO,
  aFechaCiclo,
  hoyNegocio,
  limitesDiaNegocio,
  mondayOfBusinessWeek,
} from "@rassa-jala/db";
import type { Database, Prisma } from "@rassa-jala/db";

import { visiblePara } from "./pedidos";
import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";

// P1-F Historiales y reportes operativos (docs/roadmap.md §6 P1-F; odd/tasks/
// p1-historiales.md). READ-ONLY module: no write procedures, no schema change —
// the histories are already append-only (historial_estado_pedido,
// historial_estado_recoleccion) and merma is List+Retrieve+Create.
//
// Sources (concepts only, never copied):
// - legacy /pedidos/{id}/historial/ (pedido/views.py + HistorialEstadoSerializer):
//   chronological by creado_en, rows { estado_anterior, estado_nuevo,
//   cambiado_por_nombre, creado_en }. v2 keeps ONE state per row (M-12) so the
//   previous state is the prior row's — derived here, never stored.
// - legacy MermaResumenView (waste/views.py, Admin-only analytics; roadmap §7
//   gap 18): filters fecha_desde/fecha_hasta (creado_en calendar date) +
//   producto_id + agrupar_por 'mes'|'semana' (default mes); response
//   { agrupacion, total_general, producto_mas_afectado:{nombre,total}|null,
//     detalle[{ periodo, producto_nombre, producto_id, decision_nombre,
//     decision_id, total_cantidad, total_mermas }] } ordered -periodo,
//   -total_cantidad, limited to 100. estado=True rows only.
//
// Business TZ (Q-22): the legacy truncated creado_en in its session TZ; v2
// evaluates the calendar date / Monday in America/Mazatlan (hoyNegocio /
// mondayOfBusinessWeek) and the date window via limitesDiaNegocio — exact
// parity for the "creado_en date in [desde, hasta]" predicate.
//
// Scoping (stricter than legacy — legacy's historial action let any
// authenticated Cliente read any pedido's log; v2 uniformizes to 403, the same
// deviation already applied in pedidos.detalle):
// - historialPedido: Cliente own, Vendedor assigned, Admin all (visiblePara
//   parity with pedidos.detalle); Agricultor 403.
// - historialRecoleccion: Agricultor own only, Vendedor/Admin all, Cliente 403
//   (recolecciones.detalle parity).
// - resumenMermas: Admin-only (legacy HasRole(ADMIN)).
//
// COL23: server-fetched reads only, NO RxDB collection (web at the cap).

const ID = z.uuid();
const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (YYYY-MM-DD)");

function asegurarRol(rol: Role, permitidos: Role[], mensaje: string): void {
  if (!permitidos.includes(rol)) {
    throw new TRPCError({ code: "FORBIDDEN", message: mensaje });
  }
}

/** Legacy `_nombre_completo` parity: actor display name from usuario→persona. */
async function nombresDeActores(db: Database, ids: string[]): Promise<Map<string, string | null>> {
  const unicos = [...new Set(ids.filter((id) => id.length > 0))];
  if (unicos.length === 0) return new Map();
  const filas = await db.usuario.findMany({
    where: { id: { in: unicos } },
    select: {
      id: true,
      persona: { select: { nombre: true, apellidoPaterno: true } },
    },
  });
  return new Map(
    filas.map((u) => [
      u.id,
      u.persona ? `${u.persona.nombre} ${u.persona.apellidoPaterno}`.trim() : null,
    ]),
  );
}

// ---- pedido historial ----

export type HistorialFila = {
  id: string;
  estadoAnterior: string | null;
  estadoNuevo: string;
  actor: string | null;
  fecha: string;
};

export const historialesRouter = router({
  // Legacy GET /pedidos/{id}/historial/ parity: chronological rows with the
  // actor NAME; the previous state derives from the prior row (M-12 one-state
  // rows). Scoping = pedidos.detalle (visiblePara).
  historialPedido: protectedProcedure.input(z.object({ id: ID })).query(async ({ input, ctx }) => {
    const fila = await ctx.db.pedidoCabecera.findUnique({
      where: { id: input.id },
      select: { id: true, fkCliente: true, fkVendedor: true },
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
    const nombres = await nombresDeActores(
      ctx.db,
      historial.map((h) => h.actor ?? ""),
    );
    const filas: HistorialFila[] = historial.map((h, i) => ({
      id: h.id,
      estadoAnterior: i > 0 ? (historial[i - 1]?.estado.nombre ?? null) : null,
      estadoNuevo: h.estado.nombre,
      actor: h.actor ? (nombres.get(h.actor) ?? null) : null,
      fecha: h.fecha.toISOString(),
    }));
    return filas;
  }),

  // Recolección lifecycle log (historial_estado_recoleccion, anterior/nuevo
  // pair stored verbatim). Scoping = recolecciones.detalle.
  historialRecoleccion: protectedProcedure
    .input(z.object({ id: ID }))
    .query(async ({ input, ctx }) => {
      const fila = await ctx.db.recoleccion.findUnique({
        where: { id: input.id },
        select: { id: true, fkAgricultor: true },
      });
      if (!fila) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recolección no encontrada" });
      }
      if (ctx.user.rol === ROLE.CLIENTE) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Un cliente no consulta recolecciones" });
      }
      if (ctx.user.rol === ROLE.AGRICULTOR && fila.fkAgricultor !== ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Un agricultor solo puede consultar sus propias recolecciones.",
        });
      }
      const historial = await ctx.db.historialEstadoRecoleccion.findMany({
        where: { fkRecoleccion: fila.id },
        orderBy: { creadoEn: "asc" },
      });
      const nombres = await nombresDeActores(
        ctx.db,
        historial.map((h) => h.fkCambiadoPor ?? ""),
      );
      return historial.map((h) => ({
        id: h.id,
        estadoAnterior: h.estadoAnterior,
        estadoNuevo: h.estadoNuevo,
        actor: h.fkCambiadoPor ? (nombres.get(h.fkCambiadoPor) ?? null) : null,
        fecha: h.creadoEn.toISOString(),
      })) satisfies HistorialFila[];
    }),

  // Legacy MermaResumenView (Admin-only, roadmap §7 gap 18 closure).
  resumenMermas: protectedProcedure
    .input(
      z.object({
        fechaDesde: FECHA.optional(),
        fechaHasta: FECHA.optional(),
        // Legacy filtered fk_producto_semanal__fk_producto_id — the MAESTRO
        // producto id (v2 UUID), not the weekly offer's.
        fkProducto: ID.optional(),
        agruparPor: z.enum(["mes", "semana"]).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, [ROLE.ADMIN], "Solo el rol Admin consulta el resumen de mermas");

      // Legacy validation order/messages (parse_date_param failures surface as
      // clean 400s through the schema; the cross-field check keeps the exact
      // legacy wording).
      const { fechaDesde, fechaHasta, fkProducto } = input;
      if (fechaDesde && fechaHasta && fechaDesde > fechaHasta) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "fecha_desde no puede ser mayor a fecha_hasta.",
        });
      }
      const agruparPor = input.agruparPor ?? "mes";

      // creado_en date ∈ [desde, hasta] in America/Mazatlan → instant window
      // [inicio(desde), fin(hasta)) (limitesDiaNegocio bounds, fin exclusive —
      // the same predicate the pedidos/cortes windows use).
      const where: Prisma.MermaWhereInput = { estado: true };
      if (fechaDesde || fechaHasta) {
        where.creadoEn = {
          ...(fechaDesde ? { gte: limitesDiaNegocio(fechaDesde).inicio } : {}),
          ...(fechaHasta ? { lt: limitesDiaNegocio(fechaHasta).fin } : {}),
        };
      }
      if (fkProducto) {
        where.productoSemanal = { fkProducto };
      }

      const filas = await ctx.db.merma.findMany({
        where,
        select: {
          cantidad: true,
          creadoEn: true,
          decision: { select: { id: true, decision: true } },
          productoSemanal: { select: { fkProducto: true, producto: { select: { nombre: true } } } },
        },
      });

      // Legacy aggregation semantics, computed in JS over the (few) rows so the
      // Mazatlan wall-time truncation is exact without SQL TZ gymnastics.
      const totalGeneral = filas.reduce((s, f) => s + f.cantidad, 0);

      const porProducto = new Map<string, number>();
      for (const f of filas) {
        const nombre = f.productoSemanal?.producto.nombre;
        if (!nombre) continue;
        porProducto.set(nombre, (porProducto.get(nombre) ?? 0) + f.cantidad);
      }
      let productoMasAfectado: { nombre: string; total: number } | null = null;
      for (const [nombre, total] of porProducto) {
        // order_by("-total", "producto_nombre") + first(): max total, name-asc tie-break.
        if (
          productoMasAfectado === null ||
          total > productoMasAfectado.total ||
          (total === productoMasAfectado.total && nombre < productoMasAfectado.nombre)
        ) {
          productoMasAfectado = { nombre, total };
        }
      }

      const grupos = new Map<
        string,
        {
          periodo: string;
          productoNombre: string;
          productoId: string;
          decisionNombre: string;
          decisionId: string;
          totalCantidad: number;
          totalMermas: number;
        }
      >();
      for (const f of filas) {
        const ps = f.productoSemanal;
        if (!ps) continue; // SetNull orphans drop out of every product grouping
        // TruncMonth/TruncWeek of creado_en on the Mazatlan wall calendar
        // (Q-22); TruncWeek truncates to the week's Monday, like Q-25.
        const diaNegocio = hoyNegocio(f.creadoEn);
        const periodo =
          agruparPor === "mes"
            ? `${diaNegocio.slice(0, 7)}-01`
            : aFechaCiclo(mondayOfBusinessWeek(f.creadoEn));
        const llave = `${periodo}|${ps.fkProducto}|${f.decision.id}`;
        const g = grupos.get(llave);
        if (g) {
          g.totalCantidad += f.cantidad;
          g.totalMermas += 1;
        } else {
          grupos.set(llave, {
            periodo,
            productoNombre: ps.producto.nombre,
            productoId: ps.fkProducto,
            decisionNombre: f.decision.decision,
            decisionId: f.decision.id,
            totalCantidad: f.cantidad,
            totalMermas: 1,
          });
        }
      }
      // Legacy order: -periodo, -total_cantidad; a name tie-break keeps the
      // slice deterministic (legacy SQL left the rest unordered).
      const detalle = [...grupos.values()]
        .sort(
          (a, b) =>
            b.periodo.localeCompare(a.periodo) ||
            b.totalCantidad - a.totalCantidad ||
            a.productoNombre.localeCompare(b.productoNombre) ||
            a.decisionNombre.localeCompare(b.decisionNombre),
        )
        .slice(0, 100);

      return {
        agrupacion: agruparPor,
        totalGeneral,
        productoMasAfectado,
        detalle,
      };
    }),

  // Gap-pass-7 T27 (PDF FASE 13.4): average delivery time for the Admin
  // dashboard. Measured window (documented decision): FIRST `confirmado` →
  // `entregado` — the reduced v2 catalog collapsed en_preparacion/listo_para_retirar
  // into `confirmado` (gap-pass-7 W-A), so confirmation is when the operation
  // takes the order; the earlier pendiente stretch is client browsing lag, not
  // ops time. Q-22: durations are UTC-instant differences averaged as durations
  // (never wall-clock hours); the Mazatlan calendar only buckets WHICH delivered
  // orders fall inside the N-day window.
  tiempoEntrega: protectedProcedure
    .input(z.object({ dias: z.number().int().min(1).max(365).optional() }))
    .query(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, [ROLE.ADMIN], "Solo el rol Admin consulta el tiempo de entrega");
      const dias = input.dias ?? 30;

      // Delivered-in-window: the entregado transition instant ∈ [hoy-(dias-1),
      // hoy) business days, as limitesDiaNegocio UTC instants (fin exclusive —
      // the same window predicate resumenMermas/pedidos use).
      const hoy = hoyNegocio(new Date());
      const desdeDia = new Date(`${hoy}T00:00:00.000Z`);
      desdeDia.setUTCDate(desdeDia.getUTCDate() - (dias - 1));
      const inicio = limitesDiaNegocio(aFechaCiclo(desdeDia)).inicio;
      const fin = limitesDiaNegocio(hoy).fin;

      const entregados = await ctx.db.historialEstadoPedido.findMany({
        where: {
          estado: { nombre: ESTADO_PEDIDO.ENTREGADO },
          fecha: { gte: inicio, lt: fin },
        },
        select: { fkPedido: true, fecha: true },
      });

      // First confirmado per delivered pedido — a separate query because it may
      // predate the window (confirmed 35 days ago, delivered yesterday).
      const confirmados = await ctx.db.historialEstadoPedido.findMany({
        where: {
          fkPedido: { in: entregados.map((e) => e.fkPedido) },
          estado: { nombre: ESTADO_PEDIDO.CONFIRMADO },
        },
        orderBy: { fecha: "asc" },
        select: { fkPedido: true, fecha: true },
      });
      const primerConfirmado = new Map<string, Date>();
      for (const c of confirmados) {
        if (!primerConfirmado.has(c.fkPedido)) primerConfirmado.set(c.fkPedido, c.fecha);
      }

      // Orders without a confirmado row (edge imports) can't produce a duration:
      // they count in pedidosEntregados but drop out of the average. A disordered
      // pair (entregado before confirmado — legacy import anomaly) drops too.
      const duracionesMs: number[] = [];
      for (const e of entregados) {
        const confirmado = primerConfirmado.get(e.fkPedido);
        if (confirmado && e.fecha.getTime() >= confirmado.getTime()) {
          duracionesMs.push(e.fecha.getTime() - confirmado.getTime());
        }
      }
      const promedioHoras =
        duracionesMs.length === 0
          ? null
          : duracionesMs.reduce((s, d) => s + d, 0) / duracionesMs.length / 3_600_000;

      return {
        dias,
        pedidosEntregados: entregados.length,
        promedioHoras,
      };
    }),
});
