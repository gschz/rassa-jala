import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import { limitesDiaNegocio } from "@rassa-jala/db/estados-corte";
import { hoyNegocio } from "@rassa-jala/db/iso-semana";

import {
  ADMIN,
  AGRO,
  CLIENTE,
  DEV_PASSWORD,
  VENDEDOR,
  ensureFixtures,
  ensureServer,
  pgQuery,
  pgUna,
  sufijo,
  tokenDe,
  trpc,
} from "./helpers";

const T = 240_000;

// P1-E Dashboard e2e (docs/roadmap.md §6 P1-E; docs/design-system.md §8: metrics
// EXCLUSIVELY with real data). Proofs:
// - Correctness: every dashboard procedure's numbers are compared against DIRECT SQL
//   over the same seeded rows (aggregate parity, money in integer cents via aCentavos).
// - Known-data delta: a per-run Vendedor creates a presencial pedido via the API and
//   the vendedor dashboard's ventasHoy must move by EXACTLY the returned order total.
// - Role scoping: every other role hits a clean 403 on each endpoint (one role per
//   endpoint — the 403 matrix is the scoping proof).
// - Empty state: a fresh per-run Cliente (zero pedidos) reads all-real zeros.
// Re-run safe ×2: per-run SQL fixtures with dynamic suffixes; no data is deleted.
// CERO simulated data: the suite never asserts on any legacy mock value.

type StatsAdmin = {
  ventasHoy: string;
  ventasMes: string;
  pedidosActivos: number;
  productosActivos: number;
  agricultoresActivos: number;
  pedidosPorEstado: Array<{ estado: string; cantidad: number }>;
  usuariosPorRol: Array<{ rol: string; cantidad: number }>;
  ventasPorDia: Array<{ fecha: string; total: string }>;
  topProductos: Array<{ nombre: string; pedidos: number; importe: string }>;
  actividadReciente: Array<{ id: string; estado: string; total: string }>;
};

type StatsVendedor = {
  ventasHoy: string;
  ventasSemana: string;
  ventasMes: string;
  pedidosPorCobrar: number;
  pedidosPorEntregar: number;
};

type StatsAgricultor = {
  publicacionesPorEstado: Array<{ estado: string; cantidad: number }>;
  itemsActivos: number;
  lineasVendidas: number;
  ventasTotales: string;
  recoleccionesPendientes: number;
  mermasRegistradas: number;
};

type StatsCliente = {
  pedidosTotales: number;
  porPagar: number;
  porRecibir: number;
  entregados: number;
  cancelados: number;
  gastoTotal: string;
};

/** Exact cents of a decimal-string metric (money.ts shape from the server). */
const centavos = (valor: string): number => {
  const m = /^(-?\d{1,10})(?:\.(\d{1,2}))?$/.exec(valor);
  if (!m) throw new Error(`monto con formato inesperado: ${valor}`);
  const signo = m[1]!.startsWith("-") ? -1 : 1;
  const abs = m[1]!.replace("-", "");
  return signo * Number(abs + (m[2] ?? "").padEnd(2, "0"));
};

/** SQL fixture user (hash copied from admin → logs in with DEV_PASSWORD), re-run safe. */
async function crearUsuarioFixture(correo: string, nombre: string, rol: string): Promise<string> {
  const localidad = await pgUna<{ id: string }>(
    "select id from localidad where nombre = 'Tepic' and estado order by id limit 1",
  );
  const personaId = crypto.randomUUID();
  await pgQuery(
    `insert into persona (id, nombre, apellido_paterno, fk_localidad)
     values ($1, $2, 'Dash', $3)
     on conflict (id) do nothing`,
    [personaId, nombre, localidad.id],
  );
  await pgQuery(
    `insert into usuario (id, correo, password_hash, fk_persona, fk_rol, estado)
     select gen_random_uuid(), $1, u.password_hash, $2, r.id, true
     from usuario u, roles r
     where u.correo = $3 and r.nombre = $4
     on conflict (correo) do nothing`,
    [correo, personaId, ADMIN, rol],
  );
  return (await pgUna<{ id: string }>("select id from usuario where correo = $1", [correo])).id;
}

describe("dashboard e2e (p1-dashboard proofs)", () => {
  let adminToken = "";
  let vendedorToken = "";
  let agroToken = "";
  let clienteToken = "";
  let vendFixToken = "";
  let farmerFixToken = "";
  let agroVacioToken = "";
  let clienteFixToken = "";
  let vendedorFixId = "";
  let itemMoneyId = "";

  beforeAll(async () => {
    await ensureServer();
    await ensureFixtures();
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
    vendedorToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    clienteToken = await tokenDe(CLIENTE, DEV_PASSWORD);
    const s = sufijo();
    const correoVend = `e2e-dash-vend-${s}@fixture.local`;
    const correoAgro = `e2e-dash-agro-${s}@fixture.local`;
    const correoCliente = `e2e-dash-cli-${s}@fixture.local`;
    vendedorFixId = await crearUsuarioFixture(correoVend, `VendDash${s}`, "Vendedor");
    await crearUsuarioFixture(correoAgro, `AgroDash${s}`, "Agricultor");
    await crearUsuarioFixture(correoCliente, `CliDash${s}`, "Cliente");
    vendFixToken = await tokenDe(correoVend, DEV_PASSWORD);
    // The FIXED fixture farmer (helpers.ts) owns known publications/items — the
    // agricultor-parity test reads ITS stats; the empty-state test uses fresh users.
    farmerFixToken = await tokenDe("e2e-farmer@fixture.local", DEV_PASSWORD);
    agroVacioToken = await tokenDe(correoAgro, DEV_PASSWORD);
    clienteFixToken = await tokenDe(correoCliente, DEV_PASSWORD);
    itemMoneyId = (await ensureFixtures()).itemMoneyId; // precio 10.13, stock 1000
  }, T);

  test(
    "admin stats match direct SQL (estados, roles, activos, ventas del día)",
    async () => {
      const stats = await trpc<StatsAdmin>("query", "dashboard.admin", undefined, adminToken);
      expect(stats.ok).toBe(true);
      if (!stats.ok) return;
      const s = stats.data;

      const estados = await pgQuery<{ estado: string; n: number }>(
        `select e.nombre estado, count(*)::int n
         from pedido_cabecera p join estado_pedido e on e.id = p.fk_estado
         where p.estado group by e.nombre`,
      );
      for (const fila of estados) {
        const reportado = s.pedidosPorEstado.find((e) => e.estado === fila.estado);
        expect(reportado?.cantidad).toBe(fila.n);
      }

      const roles = await pgQuery<{ rol: string; n: number }>(
        `select r.nombre rol, count(*)::int n from usuario u
         join roles r on r.id = u.fk_rol where u.estado group by r.nombre`,
      );
      for (const fila of roles) {
        const reportado = s.usuariosPorRol.find((r) => r.rol === fila.rol);
        expect(reportado?.cantidad).toBe(fila.n);
      }

      const activos = await pgUna<{ n: number }>(
        `select count(*)::int n from pedido_cabecera p join estado_pedido e on e.id = p.fk_estado
         where p.estado and e.nombre not in ('entregado', 'cancelado')`,
      );
      expect(s.pedidosActivos).toBe(activos.n);

      const productos = await pgUna<{ n: number }>(
        "select count(*)::int n from producto where estado",
      );
      expect(s.productosActivos).toBe(productos.n);

      const agricultores = await pgUna<{ n: number }>(
        `select count(*)::int n from usuario u join roles r on r.id = u.fk_rol
         where u.estado and r.nombre = 'Agricultor'`,
      );
      expect(s.agricultoresActivos).toBe(agricultores.n);

      const hoy = hoyNegocio(new Date());
      const { inicio, fin } = limitesDiaNegocio(hoy);
      const ventas = await pgUna<{ s: string }>(
        `select coalesce(sum(total), 0)::text s from pedido_cabecera
         where estado and fk_estado <> (select id from estado_pedido where nombre = 'cancelado')
           and creado_en >= $1 and creado_en < $2`,
        [inicio.toISOString(), fin.toISOString()],
      );
      expect(centavos(s.ventasHoy)).toBe(Math.round(Number(ventas.s) * 100));

      // The 7-day series covers today AND the previous six (real zeros allowed).
      expect(s.ventasPorDia).toHaveLength(7);
      expect(s.ventasPorDia[6]!.fecha).toBe(hoy);
    },
    T,
  );

  test(
    "vendedor ventasHoy moves by EXACTLY the created presencial pedido total (delta + SQL parity)",
    async () => {
      const antes = await trpc<StatsVendedor>(
        "query",
        "dashboard.vendedor",
        undefined,
        vendFixToken,
      );
      expect(antes.ok).toBe(true);
      if (!antes.ok) return;

      const pedido = await trpc<{
        id: string;
        total: string;
        estadoNombre: string;
        fkVendedor: string | null;
      }>(
        "mutation",
        "pedidos.pedidoPresencial",
        {
          clienteNombre: `Cliente Dashboard ${sufijo()}`,
          items: [{ fkProductoSemanal: itemMoneyId, cantidad: 2 }],
        },
        vendFixToken,
      );
      expect(pedido.ok).toBe(true);
      if (!pedido.ok) return;
      expect(pedido.data.fkVendedor).toBe(vendedorFixId);

      const despues = await trpc<StatsVendedor>(
        "query",
        "dashboard.vendedor",
        undefined,
        vendFixToken,
      );
      expect(despues.ok).toBe(true);
      if (!despues.ok) return;

      // The ONLY sales change is this order: delta = its server-computed total.
      expect(centavos(despues.data.ventasHoy) - centavos(antes.data.ventasHoy)).toBe(
        centavos(pedido.data.total),
      );
      // A pendiente counts as por-cobrar, NOT as por-entregar (post-pago states).
      expect(despues.data.pedidosPorCobrar).toBe(antes.data.pedidosPorCobrar + 1);
      expect(despues.data.pedidosPorEntregar).toBe(antes.data.pedidosPorEntregar);

      // SQL parity for the whole metric, not only the delta.
      const hoy = hoyNegocio(new Date());
      const { inicio, fin } = limitesDiaNegocio(hoy);
      const sql = await pgUna<{ s: string }>(
        `select coalesce(sum(total), 0)::text s from pedido_cabecera
         where fk_vendedor = $1 and estado
           and fk_estado <> (select id from estado_pedido where nombre = 'cancelado')
           and creado_en >= $2 and creado_en < $3`,
        [vendedorFixId, inicio.toISOString(), fin.toISOString()],
      );
      expect(centavos(despues.data.ventasHoy)).toBe(Math.round(Number(sql.s) * 100));
    },
    T,
  );

  test(
    "agricultor stats match direct SQL for the fixture farmer (pubs, items, líneas, mermas)",
    async () => {
      const fixtures = await ensureFixtures();
      const stats = await trpc<StatsAgricultor>(
        "query",
        "dashboard.agricultor",
        undefined,
        farmerFixToken,
      );
      expect(stats.ok).toBe(true);
      if (!stats.ok) return;
      const s = stats.data;

      const pubs = await pgQuery<{ estado: string; n: number }>(
        `select estado, count(*)::int n from publicacion_semanal
         where fk_agricultor = $1 group by estado`,
        [fixtures.farmerId],
      );
      for (const fila of pubs) {
        const reportado = s.publicacionesPorEstado.find((p) => p.estado === fila.estado);
        expect(reportado?.cantidad).toBe(fila.n);
      }

      const items = await pgUna<{ n: number }>(
        `select count(*)::int n from producto_semanal ps
         join publicacion_semanal p on p.id = ps.fk_publicacion
         where p.fk_agricultor = $1 and ps.estado = 'activo'`,
        [fixtures.farmerId],
      );
      expect(s.itemsActivos).toBe(items.n);

      const lineas = await pgUna<{ n: number; s: string }>(
        `select count(*)::int n, coalesce(sum(d.importe), 0)::text s
         from detalle_pedido d
         join producto_semanal ps on ps.id = d.fk_producto_semanal
         join publicacion_semanal p on p.id = ps.fk_publicacion
         join pedido_cabecera pc on pc.id = d.fk_pedido
         join estado_pedido e on e.id = pc.fk_estado
         where p.fk_agricultor = $1 and e.nombre <> 'cancelado'`,
        [fixtures.farmerId],
      );
      expect(s.lineasVendidas).toBe(lineas.n);
      expect(centavos(s.ventasTotales)).toBe(Math.round(Number(lineas.s) * 100));

      const mermas = await pgUna<{ n: number }>(
        `select count(*)::int n from merma m
         join pedido_cabecera pc on pc.id = m.fk_pedido
         join detalle_pedido d on d.fk_pedido = pc.id
         join producto_semanal ps on ps.id = d.fk_producto_semanal
         join publicacion_semanal p on p.id = ps.fk_publicacion
         where m.estado and p.fk_agricultor = $1`,
        [fixtures.farmerId],
      );
      expect(s.mermasRegistradas).toBe(mermas.n);
    },
    T,
  );

  test(
    "scoping: wrong roles get 403 on every dashboard endpoint",
    async () => {
      const casos: Array<[string, string]> = [
        ["dashboard.admin", vendedorToken],
        ["dashboard.admin", agroToken],
        ["dashboard.admin", clienteToken],
        ["dashboard.vendedor", adminToken],
        ["dashboard.vendedor", agroToken],
        ["dashboard.vendedor", clienteToken],
        ["dashboard.agricultor", vendedorToken],
        ["dashboard.agricultor", clienteToken],
        ["dashboard.cliente", adminToken],
        ["dashboard.cliente", agroToken],
      ];
      for (const [ruta, token] of casos) {
        const res = await trpc("query", ruta, undefined, token);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errorCode).toBe("FORBIDDEN");
      }
    },
    T,
  );

  test(
    "empty state: fresh per-run Cliente reads real zeros; fresh Agricultor has no ventas",
    async () => {
      const cliente = await trpc<StatsCliente>(
        "query",
        "dashboard.cliente",
        undefined,
        clienteFixToken,
      );
      expect(cliente.ok).toBe(true);
      if (!cliente.ok) return;
      expect(cliente.data.pedidosTotales).toBe(0);
      expect(cliente.data.porPagar).toBe(0);
      expect(cliente.data.porRecibir).toBe(0);
      expect(cliente.data.entregados).toBe(0);
      expect(cliente.data.cancelados).toBe(0);
      expect(cliente.data.gastoTotal).toBe("0.00");

      const agro = await trpc<StatsAgricultor>(
        "query",
        "dashboard.agricultor",
        undefined,
        agroVacioToken,
      );
      expect(agro.ok).toBe(true);
      if (!agro.ok) return;
      expect(agro.data.itemsActivos).toBe(0);
      expect(agro.data.lineasVendidas).toBe(0);
      expect(agro.data.ventasTotales).toBe("0.00");
      expect(agro.data.publicacionesPorEstado).toEqual([]);
    },
    T,
  );
});
