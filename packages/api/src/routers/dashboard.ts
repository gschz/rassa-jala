import { TRPCError } from "@trpc/server";

import {
  ESTADO_PEDIDO,
  ESTADO_RECOLECCION,
  ESTADOS_TERMINALES_PEDIDO,
  aFechaCiclo,
  hoyNegocio,
  limitesDiaNegocio,
  mondayOfBusinessWeek,
} from "@rassa-jala/db";
import type { Database, Prisma } from "@rassa-jala/db";

import { aCentavos, sumaCentavos, type Cents } from "../money";
import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";
import { cachedDashboard } from "./dashboard-cache";

// P1-E Dashboard real (docs/roadmap.md §6 P1-E; docs/design-system.md §8: metrics
// and charts EXCLUSIVELY with real data). The legacy dashboards were 100% mocked
// (services/mock/dashboard.ts was their only data source); the metric SET shown per
// role is reproduced here from the legacy UI, but every metric maps to a REAL query
// over the v2 tables. Metrics with no real source were either mapped to their real
// equivalent or omitted — never faked:
//
//   legacy (mock)                    → real query (v2)
//   Admin  "Ventas de hoy"           → Σ pedido_cabecera.total (no cancelado) inside
//                                      the Mazatlan business day (limitesDiaNegocio)
//   Admin  "Ingresos del mes"        → Σ total inside the current Mazatlan month
//   Admin  "Pedidos activos"         → count estado NOT IN (entregado, cancelado)
//   Admin  "Productores"             → count usuario (Agricultor, estado=true)
//   Admin  "Productos más vendidos"  → GROUP BY detalle.nombre_producto (order
//                                      snapshots — never the live product row)
//   Admin  "Ventas de la semana"     → Σ total per Mazatlan business day, last 7 days
//   Admin  "Actividad reciente"      → latest 5 pedido_cabecera rows
//   Vendedor salesToday/Week/Month   → Σ total of OWN pedidos per window
//   Vendedor pendingDeliveries       → own count post-payment 'confirmado' (the
//                                      only pre-delivery state in the reduced v2
//                                      catalog), pendingCollections → own count
//                                      'pendiente' (not yet claimed/paid)
//   Agricultor products/active       → own publicaciones GROUP BY estado + own
//                                      producto_semanal 'activo' count
//   Agricultor ordersReceived/revenue→ own detail lines (importes, no cancelado)
//   Cliente (no legacy stats)        → minimal own pedidos by estado + Σ total
//
// Rules: scoping server-side per procedure (one role per endpoint — a wrong role is
// a clean 403, matching the module's uniform role messages); money in integer cents
// via money.ts (DB numeric sums are exact Decimals; the per-order sums happen in JS
// over the day's rows so every amount crosses aCentavos); day/week/month boundaries
// in America/Mazatlan reusing limitesDiaNegocio/hoyNegocio. Read-only: no outbox
// writes, no RxDB collection (COL23 untouched).

function asegurarRol(rol: Role, permitidos: Role[], mensaje: string): void {
  if (!permitidos.includes(rol)) {
    throw new TRPCError({ code: "FORBIDDEN", message: mensaje });
  }
}

/** Exact sum of order totals in integer cents (money.ts — never float). */
function sumaTotales(filas: Array<{ total: Prisma.Decimal }>): Cents {
  return sumaCentavos(filas.map((f) => aCentavos(f.total.toFixed(2))));
}

/** Exact sum of detail importes in integer cents (money.ts). */
function sumaImportes(filas: Array<{ importe: Prisma.Decimal }>): Cents {
  return sumaCentavos(filas.map((f) => aCentavos(f.importe.toFixed(2))));
}

const PEDIDOS_VALIDOS = {
  estado: true,
  estadoPedido: { nombre: { not: ESTADO_PEDIDO.CANCELADO } },
} satisfies Prisma.PedidoCabeceraWhereInput;

function nombrePersona(p: { nombre: string; apellidoPaterno: string } | null): string | null {
  return p ? `${p.nombre} ${p.apellidoPaterno}` : null;
}

/** Mazatlan business-day string of any instant (hoyNegocio formats arbitrary instants). */
const diaDe = (instante: Date): string => hoyNegocio(instante);

/** Last N business-day date strings ending today (America/Mazatlan), oldest first. */
function ultimosDias(cantidad: number, hoy: string): string[] {
  const dias: string[] = [];
  for (let i = cantidad - 1; i >= 0; i -= 1) {
    dias.push(aFechaCiclo(new Date(Date.parse(`${hoy}T00:00:00.000Z`) - i * 86_400_000)));
  }
  return dias;
}

// ---- Admin ----

type ActividadDto = {
  id: string;
  folio: string;
  cliente: string | null;
  vendedor: string | null;
  estado: string;
  total: string;
  creadoEn: string;
};

export type EstadisticasAdmin = {
  ventasHoy: string;
  ventasMes: string;
  pedidosActivos: number;
  productosActivos: number;
  agricultoresActivos: number;
  pedidosPorEstado: Array<{ estado: string; cantidad: number }>;
  usuariosPorRol: Array<{ rol: string; cantidad: number }>;
  ventasPorDia: Array<{ fecha: string; total: string }>;
  topProductos: Array<{ nombre: string; pedidos: number; importe: string }>;
  actividadReciente: ActividadDto[];
};

export async function estadisticasAdmin(db: Database): Promise<EstadisticasAdmin> {
  const hoy = hoyNegocio(new Date());
  const { inicio: inicioHoy, fin: finHoy } = limitesDiaNegocio(hoy);
  // Month start in Mazatlan: the business day 'YYYY-MM-01' bounds the month window.
  const inicioMes = limitesDiaNegocio(`${hoy.slice(0, 7)}-01`).inicio;
  const dias = ultimosDias(7, hoy);

  const [
    hoyFilas,
    mesFilas,
    semanaFilas,
    pedidosActivos,
    productosActivos,
    agricultores,
    porEstado,
    porRol,
    topGrupos,
    recientes,
  ] = await Promise.all([
    db.pedidoCabecera.findMany({
      where: { ...PEDIDOS_VALIDOS, creadoEn: { gte: inicioHoy, lt: finHoy } },
      select: { total: true },
    }),
    db.pedidoCabecera.findMany({
      where: { ...PEDIDOS_VALIDOS, creadoEn: { gte: inicioMes } },
      select: { total: true },
    }),
    db.pedidoCabecera.findMany({
      where: {
        ...PEDIDOS_VALIDOS,
        creadoEn: { gte: limitesDiaNegocio(dias[0]!).inicio, lt: finHoy },
      },
      select: { total: true, creadoEn: true },
    }),
    db.pedidoCabecera.count({
      where: {
        estado: true,
        estadoPedido: { nombre: { notIn: [...ESTADOS_TERMINALES_PEDIDO] } },
      },
    }),
    db.producto.count({ where: { estado: true } }),
    db.usuario.count({ where: { estado: true, rol: { nombre: ROLE.AGRICULTOR } } }),
    db.pedidoCabecera.groupBy({
      by: ["fkEstado"],
      _count: { _all: true },
      where: { estado: true },
    }),
    db.usuario.groupBy({ by: ["fkRol"], _count: { _all: true }, where: { estado: true } }),
    db.detallePedido.groupBy({
      by: ["nombreProducto"],
      _count: { _all: true },
      _sum: { importe: true },
      where: { pedido: PEDIDOS_VALIDOS },
      orderBy: { _sum: { importe: "desc" } },
      take: 5,
    }),
    db.pedidoCabecera.findMany({
      where: { estado: true },
      orderBy: { creadoEn: "desc" },
      take: 5,
      select: {
        id: true,
        folio: true,
        total: true,
        creadoEn: true,
        estadoPedido: { select: { nombre: true } },
        cliente: { select: { persona: { select: { nombre: true, apellidoPaterno: true } } } },
        vendedor: { select: { persona: { select: { nombre: true, apellidoPaterno: true } } } },
      },
    }),
  ]);

  // Catalog rows give the FULL distribution (0-count rows included — real zeros).
  const [catalogoEstados, catalogoRoles] = await Promise.all([
    db.estadoPedido.findMany({ where: { estado: true }, select: { id: true, nombre: true } }),
    db.rol.findMany({ select: { id: true, nombre: true } }),
  ]);
  const conteoEstados = new Map(porEstado.map((g) => [g.fkEstado, g._count._all]));
  const conteoRoles = new Map(porRol.map((g) => [g.fkRol, g._count._all]));

  // Group the week's rows in JS by Mazatlan business day (a handful of rows).
  const porDia = new Map<string, Cents>(dias.map((d) => [d, 0]));
  for (const fila of semanaFilas) {
    const dia = diaDe(fila.creadoEn);
    const previo = porDia.get(dia);
    if (previo !== undefined) {
      porDia.set(dia, previo + aCentavos(fila.total.toFixed(2)));
    }
  }

  return {
    ventasHoy: (sumaTotales(hoyFilas) / 100).toFixed(2),
    ventasMes: (sumaTotales(mesFilas) / 100).toFixed(2),
    pedidosActivos,
    productosActivos,
    agricultoresActivos: agricultores,
    pedidosPorEstado: catalogoEstados.map((e) => ({
      estado: e.nombre,
      cantidad: conteoEstados.get(e.id) ?? 0,
    })),
    usuariosPorRol: catalogoRoles.map((r) => ({
      rol: r.nombre,
      cantidad: conteoRoles.get(r.id) ?? 0,
    })),
    ventasPorDia: dias.map((fecha) => ({
      fecha,
      total: ((porDia.get(fecha) ?? 0) / 100).toFixed(2),
    })),
    topProductos: topGrupos.map((g) => ({
      nombre: g.nombreProducto,
      pedidos: g._count._all,
      // _sum of numeric(12,2) is an exact DB Decimal — re-shaped through aCentavos.
      importe: (aCentavos((g._sum.importe ?? 0).toFixed(2)) / 100).toFixed(2),
    })),
    actividadReciente: recientes.map((p) => ({
      id: p.id,
      folio: p.folio,
      cliente: nombrePersona(p.cliente?.persona ?? null),
      vendedor: nombrePersona(p.vendedor?.persona ?? null),
      estado: p.estadoPedido.nombre,
      total: p.total.toFixed(2),
      creadoEn: p.creadoEn.toISOString(),
    })),
  };
}

// ---- Vendedor ----

export type EstadisticasVendedor = {
  ventasHoy: string;
  ventasSemana: string;
  ventasMes: string;
  pedidosPorCobrar: number;
  pedidosPorEntregar: number;
};

export async function estadisticasVendedor(
  db: Database,
  fkVendedor: string,
): Promise<EstadisticasVendedor> {
  const hoy = hoyNegocio(new Date());
  const { inicio: inicioHoy, fin: finHoy } = limitesDiaNegocio(hoy);
  const inicioMes = limitesDiaNegocio(`${hoy.slice(0, 7)}-01`).inicio;
  // Business week starts on the Mazatlan Monday (Q-25 helper reused).
  const lunes = aFechaCiclo(mondayOfBusinessWeek(new Date()));
  const propios: Prisma.PedidoCabeceraWhereInput = { fkVendedor, ...PEDIDOS_VALIDOS };

  const [hoyFilas, semanaFilas, mesFilas, porCobrar, porEntregar] = await Promise.all([
    db.pedidoCabecera.findMany({
      where: { ...propios, creadoEn: { gte: inicioHoy, lt: finHoy } },
      select: { total: true },
    }),
    db.pedidoCabecera.findMany({
      where: { ...propios, creadoEn: { gte: limitesDiaNegocio(lunes).inicio } },
      select: { total: true },
    }),
    db.pedidoCabecera.findMany({
      where: { ...propios, creadoEn: { gte: inicioMes } },
      select: { total: true },
    }),
    db.pedidoCabecera.count({
      where: { fkVendedor, estado: true, estadoPedido: { nombre: ESTADO_PEDIDO.PENDIENTE } },
    }),
    db.pedidoCabecera.count({
      // Post-payment deliveries pending: `confirmado` is the only pre-delivery
      // state left in the reduced catalog (legacy intermediates are gone).
      where: { fkVendedor, estado: true, estadoPedido: { nombre: ESTADO_PEDIDO.CONFIRMADO } },
    }),
  ]);

  return {
    ventasHoy: (sumaTotales(hoyFilas) / 100).toFixed(2),
    ventasSemana: (sumaTotales(semanaFilas) / 100).toFixed(2),
    ventasMes: (sumaTotales(mesFilas) / 100).toFixed(2),
    pedidosPorCobrar: porCobrar,
    pedidosPorEntregar: porEntregar,
  };
}

// ---- Agricultor ----

export type EstadisticasAgricultor = {
  publicacionesPorEstado: Array<{ estado: string; cantidad: number }>;
  itemsActivos: number;
  lineasVendidas: number;
  ventasTotales: string;
  recoleccionesPendientes: number;
  mermasRegistradas: number;
};

export async function estadisticasAgricultor(
  db: Database,
  fkAgricultor: string,
): Promise<EstadisticasAgricultor> {
  const [pubs, itemsActivos, lineas, recolecciones, mermas] = await Promise.all([
    db.publicacionSemanal.groupBy({
      by: ["estado"],
      _count: { _all: true },
      where: { fkAgricultor },
    }),
    db.productoSemanal.count({
      where: { estado: "activo", publicacion: { fkAgricultor } },
    }),
    db.detallePedido.findMany({
      where: {
        productoSemanal: { publicacion: { fkAgricultor } },
        pedido: PEDIDOS_VALIDOS,
      },
      select: { importe: true },
    }),
    db.recoleccion.count({
      where: { fkAgricultor, estado: ESTADO_RECOLECCION.PENDIENTE },
    }),
    // The farmer's losses ride through the ORDER that fed them (M-6 link).
    db.merma.count({
      where: {
        estado: true,
        pedido: { detalles: { some: { productoSemanal: { publicacion: { fkAgricultor } } } } },
      },
    }),
  ]);

  const centavos = sumaImportes(lineas);
  return {
    publicacionesPorEstado: pubs.map((g) => ({ estado: g.estado, cantidad: g._count._all })),
    itemsActivos,
    lineasVendidas: lineas.length,
    ventasTotales: (centavos / 100).toFixed(2),
    recoleccionesPendientes: recolecciones,
    mermasRegistradas: mermas,
  };
}

// ---- Cliente ----

export type EstadisticasCliente = {
  pedidosTotales: number;
  porPagar: number;
  porRecibir: number;
  entregados: number;
  cancelados: number;
  gastoTotal: string;
};

export async function estadisticasCliente(
  db: Database,
  fkCliente: string,
): Promise<EstadisticasCliente> {
  const propios: Prisma.PedidoCabeceraWhereInput = { fkCliente, estado: true };
  const [total, porPagar, porRecibir, entregados, cancelados, filas] = await Promise.all([
    db.pedidoCabecera.count({ where: propios }),
    db.pedidoCabecera.count({
      where: { ...propios, estadoPedido: { nombre: ESTADO_PEDIDO.PENDIENTE } },
    }),
    db.pedidoCabecera.count({
      // `confirmado` is the only pre-delivery state in the reduced catalog.
      where: { ...propios, estadoPedido: { nombre: ESTADO_PEDIDO.CONFIRMADO } },
    }),
    db.pedidoCabecera.count({
      where: { ...propios, estadoPedido: { nombre: ESTADO_PEDIDO.ENTREGADO } },
    }),
    db.pedidoCabecera.count({
      where: { ...propios, estadoPedido: { nombre: ESTADO_PEDIDO.CANCELADO } },
    }),
    db.pedidoCabecera.findMany({
      where: { ...propios, ...PEDIDOS_VALIDOS },
      select: { total: true },
    }),
  ]);

  return {
    pedidosTotales: total,
    porPagar,
    porRecibir,
    entregados,
    cancelados,
    gastoTotal: (sumaTotales(filas) / 100).toFixed(2),
  };
}

// ---- procedures (one role per endpoint — scoping is the 403 matrix) ----

const MSG_SOLO = (rol: string): string => `Solo el rol ${rol} puede consultar este dashboard`;

// Gap 24: MVP in-memory TTL cache for dashboard reads. The dashboards are
// scan-heavy aggregations hit on every page load. The cache lives in
// ./dashboard-cache together with the generation counter: EVERY successful
// mutation bumps the generation (see the protectedProcedure middleware in
// src/index.ts), so a dashboard read after any write always recomputes —
// a read is never served from a pre-write entry. Per-process scope (no
// sharing across server processes; fine while the API runs as a single Bun
// instance). Role checks stay OUTSIDE the cache: a forbidden role is never
// served from it.

export const dashboardRouter = router({
  admin: protectedProcedure.query(({ ctx }) => {
    asegurarRol(ctx.user.rol, [ROLE.ADMIN], MSG_SOLO("Admin"));
    return cachedDashboard("admin", ctx.user.id, () => estadisticasAdmin(ctx.db));
  }),

  vendedor: protectedProcedure.query(({ ctx }) => {
    asegurarRol(ctx.user.rol, [ROLE.VENDEDOR], MSG_SOLO("Vendedor"));
    return cachedDashboard("vendedor", ctx.user.id, () =>
      estadisticasVendedor(ctx.db, ctx.user.id),
    );
  }),

  agricultor: protectedProcedure.query(({ ctx }) => {
    asegurarRol(ctx.user.rol, [ROLE.AGRICULTOR], MSG_SOLO("Agricultor"));
    return cachedDashboard("agricultor", ctx.user.id, () =>
      estadisticasAgricultor(ctx.db, ctx.user.id),
    );
  }),

  cliente: protectedProcedure.query(({ ctx }) => {
    asegurarRol(ctx.user.rol, [ROLE.CLIENTE], MSG_SOLO("Cliente"));
    return cachedDashboard("cliente", ctx.user.id, () => estadisticasCliente(ctx.db, ctx.user.id));
  }),
});
