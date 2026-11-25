import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import { aFechaCiclo, isoWeekFromMonday, mondayOfBusinessWeek } from "@rassa-jala/db/iso-semana";

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

// P1-B Liquidaciones e2e (docs/roadmap.md §6 P1-B; database.md §3.5 rows + M-16,
// §4.2 uniques, §4.6/§4.7 formula validated 5/5; backend-audit L1-L9). Rules
// extracted from legacy/rassa_back/rassa/blueprints/liquidaciones — never copied:
// - calcular (Admin-only): monto_ventas sums ONLY the agricultor's own delivered
//   lines in the ISO week window (Mazatlan creado_en dates); comision = HALF_UP 10%
//   exact cents; monto_liquidar = ventas - comision (DB CHECK). tasa from request
//   is IGNORED (legacy test parity).
// - L7: FULL UNIQUE (fk_agricultor, periodo_inicio, periodo_fin) — ANY state blocks
//   a re-calculation; a racing duplicate gets the legacy 409 message.
// - L8: marcar_pagada locks the row; replay with same tipo+referencia → 200 same
//   detail and PG counts unchanged; distinct data → 409; dispersion pago is
//   fk_pedido NULL with a folio from the pago sequence, NO recibo.
// - Scoping: EVERYTHING Admin-only; vendedor/agricultor/cliente → 403.
// - COL23: online-confirm module (M-16) — no RxDB collection; the suite proves the
//   online procedures + DB guarantees directly.

type LiquidacionDto = {
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
  ventas: Array<{ fkPedido: string; montoAportado: string }>;
  pago: { folio: string; monto: string; tipoPagoNombre: string } | null;
};

type TipoPagoDto = { id: string; nombre: string };

/** SQL fixtures: per-run users with the DEV password (copies of admin's hash). */
async function crearUsuarioFixture(correo: string, nombre: string, rol: string): Promise<string> {
  const localidad = await pgUna<{ id: string }>(
    "select id from localidad where nombre = 'Tepic' and estado order by id limit 1",
  );
  const personaId = crypto.randomUUID();
  await pgQuery(
    `insert into persona (id, nombre, apellido_paterno, fk_localidad)
     values ($1, $2, 'Liq', $3)
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

/**
 * SQL fixture: a per-run Agricultor + its own PUBLISHED publication (current ciclo)
 * with two known-price items (10.13 / 5.00), so the exact-money proofs never collide
 * with other suites' farmers/orders. A fresh farmer per run → no publication/slot
 * collisions across runs.
 */
async function crearFarmerConItems(
  correo: string,
  nombre: string,
): Promise<{ farmerId: string; itemA: string; itemB: string }> {
  const farmerId = await crearUsuarioFixture(correo, nombre, "Agricultor");
  const lunes = aFechaCiclo(mondayOfBusinessWeek(new Date()));
  const { semanaIso, anioIso } = isoWeekFromMonday(new Date(`${lunes}T00:00:00.000Z`));
  const pubId = crypto.randomUUID();
  await pgQuery(
    `insert into publicacion_semanal (id, fk_agricultor, fecha_ciclo, semana_iso, anio_iso, estado, version)
     values ($1, $2, $3::date, $4, $5, 'publicado', 1)`,
    [pubId, farmerId, lunes, semanaIso, anioIso],
  );
  const unidad = await pgUna<{ id: string }>(
    "select id from unidad where abreviatura = 'kg' limit 1",
  );
  // Two DIFFERENT maestro products: the partial unique 'producto_semanal_oferta_activa_unico'
  // forbids two active offers of the same product in one publication.
  const productos = await pgQuery<{ id: string }>(
    "select id from producto where nombre in ('Chile Serrano', 'Frijol') and estado order by nombre",
  );
  const itemA = crypto.randomUUID();
  const itemB = crypto.randomUUID();
  await pgQuery(
    `insert into producto_semanal (id, fk_publicacion, fk_producto, fk_unidad, precio, stock, estado, version)
     values ($1, $2, $3, $4, '10.13', 1000, 'activo', 1), ($5, $2, $6, $4, '5.00', 1000, 'activo', 1)`,
    [itemA, pubId, productos[0]?.id, unidad.id, itemB, productos[1]?.id],
  );
  return { farmerId, itemA, itemB };
}

describe("liquidaciones e2e (p1-liquidaciones proofs)", () => {
  let adminToken = "";
  let vendedorToken = "";
  let agroToken = "";
  let clienteToken = "";
  // Per-run vendedor: creates the presencial orders (Vendedor-only lane).
  let vendFixToken = "";
  // Per-run farmer + known-price items: every money proof uses ONLY this farmer.
  let farmerId = "";
  let itemA = "";
  let itemB = "";
  // Per-run EMPTY farmer (no publication at all): guaranteed "sin ventas".
  let farmerVacioId = "";
  let idEfectivo = "";
  let idTransferencia = "";
  // Per-run reference stamp for the L8 proofs (unique pago referencia).
  const referencia = `e2e-liq-${sufijo()}`;
  // Current ISO week (America/Mazatlan) + the next one (the empty-period window).
  let semana = 0;
  let anio = 0;
  let semanaSiguiente = 0;
  let anioSiguiente = 0;

  beforeAll(async () => {
    await ensureServer();
    await ensureFixtures();
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
    vendedorToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    clienteToken = await tokenDe(CLIENTE, DEV_PASSWORD);

    const s = sufijo();
    const correoVend = `e2e-liqvend-${s}@fixture.local`;
    await crearUsuarioFixture(correoVend, `VendLiq${s}`, "Vendedor");
    vendFixToken = await tokenDe(correoVend, DEV_PASSWORD);
    ({ farmerId, itemA, itemB } = await crearFarmerConItems(
      `e2e-liqfarmer-${s}@fixture.local`,
      `FarmerLiq${s}`,
    ));
    farmerVacioId = await crearUsuarioFixture(
      `e2e-liqvacio-${s}@fixture.local`,
      `VacioLiq${s}`,
      "Agricultor",
    );

    const tipos = (
      (await trpc<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendFixToken)) as {
        ok: true;
        data: TipoPagoDto[];
      }
    ).data;
    idEfectivo = tipos.find((t) => t.nombre.toLowerCase() === "efectivo")!.id;
    idTransferencia = tipos.find((t) => t.nombre.toLowerCase() === "transferencia")!.id;

    const lunes = mondayOfBusinessWeek(new Date());
    ({ semanaIso: semana, anioIso: anio } = isoWeekFromMonday(lunes));
    const lunesSig = new Date(lunes);
    lunesSig.setUTCDate(lunesSig.getUTCDate() + 7);
    ({ semanaIso: semanaSiguiente, anioIso: anioSiguiente } = isoWeekFromMonday(lunesSig));
  }, 90_000);

  /** Presencial order (per-run vendedor) → paid in cash → delivered (legacy 'entregado'). */
  const crearPedidoEntregado = async (
    items: Array<{ fkProductoSemanal: string; cantidad: number }>,
  ) => {
    const pedido = await trpc<{ id: string; total: string }>(
      "mutation",
      "pedidos.pedidoPresencial",
      { clienteNombre: `ClienteLiq${sufijo()}`, items },
      vendFixToken,
    );
    expect(pedido.ok).toBe(true);
    if (!pedido.ok) return null;
    const pago = await trpc(
      "mutation",
      "pagos.registrarPago",
      { fkPedido: pedido.data.id, fkTipoPago: idEfectivo },
      vendFixToken,
    );
    expect(pago.ok).toBe(true);
    if (!pago.ok) return null;
    const entrega = await trpc(
      "mutation",
      "pagos.marcarEntregado",
      { fkPedido: pedido.data.id },
      vendFixToken,
    );
    expect(entrega.ok).toBe(true);
    if (!entrega.ok) return null;
    return pedido.data;
  };

  const calcular = async (
    entrada: { agricultor: string; semana: number; anio: number; operationId?: string },
    token = adminToken,
  ) => trpc<LiquidacionDto>("mutation", "liquidaciones.calcular", entrada, token);

  const marcarPagada = async (
    entrada: { id: string; fkTipoPago: string; referencia?: string; operationId?: string },
    token = adminToken,
  ) => trpc<LiquidacionDto>("mutation", "liquidaciones.marcarPagada", entrada, token);

  test(
    "calcular exactitud: monto_ventas = SOLO las líneas del agricultor (multi-agricultor split), comision HALF_UP 10% en centavos",
    async () => {
      // p1 subtotal: itemA(10.13)×2 = 20.26 (MINE) + farmer2's itemOtro(7.77) = NOT mine.
      //   total = 32.51 (subtotal 28.03 + IVA 4.48) — the pedido total is NOT the
      //   liquidación basis; only my lines count.
      // p2: itemB(5.00)×1 → total 5.80.
      // Expect: monto_ventas 25.26 (2526 c); comision = HALF_UP(2526 × 0.10) = 253 c
      // (252.6 → 253, a real half-up case); monto_liquidar 22.73 (2273 c).
      const itemOtro = (await ensureFixtures()).itemOtroId;
      const p1 = await crearPedidoEntregado([
        { fkProductoSemanal: itemA, cantidad: 2 },
        { fkProductoSemanal: itemOtro, cantidad: 1 },
      ]);
      const p2 = await crearPedidoEntregado([{ fkProductoSemanal: itemB, cantidad: 1 }]);
      if (!p1 || !p2) return;
      expect(p1.total).toBe("32.51");
      expect(p2.total).toBe("5.80");

      const lunes = aFechaCiclo(mondayOfBusinessWeek(new Date()));
      const res = await calcular({ agricultor: farmerId, semana, anio });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.montoVentas).toBe("25.26");
      expect(res.data.comision).toBe("2.53");
      expect(res.data.montoLiquidar).toBe("22.73");
      expect(res.data.tasaComision).toBe("0.1000");
      expect(res.data.estado).toBe("pendiente");
      expect(res.data.periodoInicio).toBe(lunes);
      expect(res.data.ventas.length).toBe(2);
      expect(res.data.ventas.map((v) => v.montoAportado).sort()).toEqual(["20.26", "5.00"]);

      // Exact cents in PG + the M-2 CHECK really in the catalog.
      const fila = await pgUna<{ ventas: string; com: string; liq: string }>(
        `select (monto_ventas*100)::bigint::text ventas, (comision*100)::bigint::text com,
                (monto_liquidar*100)::bigint::text liq
         from liquidacion where id = $1`,
        [res.data.id],
      );
      expect(fila.ventas).toBe("2526");
      expect(fila.com).toBe("253");
      expect(fila.liq).toBe("2273");
      const check = await pgUna<{ n: number }>(
        `select count(*)::int n from pg_constraint where conname = 'liquidacion_monto_snapshot'
         and conrelid = 'liquidacion'::regclass and pg_get_constraintdef(oid) like '%monto_liquidar%'`,
      );
      expect(check.n).toBe(1);
    },
    T,
  );

  test(
    "L7 anti-duplicado: recalcular el periodo → 409 legacy; carrera concurrente (con ventas) → 1 gana; periodo sin ventas → 400",
    async () => {
      // Sequential duplicate: the current week is already calculated (pendiente).
      const dup = await calcular({ agricultor: farmerId, semana, anio });
      expect(dup.ok).toBe(false);
      if (!dup.ok) {
        expect(dup.status).toBe(409);
        expect(dup.errorMessage).toMatch(
          /^Ya existe la liquidación #[0-9a-f-]{36} para ese agricultor y periodo\.$/,
        );
      }

      // RACE with real sales: a per-run race farmer gets ONE delivered order in the
      // current week; two concurrent calcular → exactly 1 winner, 1 legacy 409.
      // (A fixed fixture farmer would keep its liquidación from the previous run —
      // the suite must pass ×2 within the same ISO week.)
      const race = await crearFarmerConItems(
        `e2e-liqrace-${sufijo()}@fixture.local`,
        `FarmerRace${sufijo()}`,
      );
      const pRace = await crearPedidoEntregado([{ fkProductoSemanal: race.itemA, cantidad: 1 }]);
      if (!pRace) return;
      const resultados = await Promise.all([
        calcular({ agricultor: race.farmerId, semana, anio }),
        calcular({ agricultor: race.farmerId, semana, anio }),
      ]);
      const exitosos = resultados.filter((r) => r.ok).length;
      expect(exitosos).toBe(1);
      const perdedor = resultados.find((r) => !r.ok);
      if (perdedor && !perdedor.ok) {
        expect(perdedor.status).toBe(409);
        expect(perdedor.errorMessage).toMatch(
          /^Ya existe la liquidación #.+ para ese agricultor y periodo\.$/,
        );
      }
      const n = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from liquidacion where fk_agricultor = $1",
          [race.farmerId],
        )
      ).n;
      expect(n).toBe(1);

      // Empty NEXT week (sequential): the clean legacy 400.
      const sinVentas = await calcular({
        agricultor: farmerId,
        semana: semanaSiguiente,
        anio: anioSiguiente,
      });
      expect(sinVentas.ok).toBe(false);
      if (!sinVentas.ok) {
        expect(sinVentas.status).toBe(400);
        expect(sinVentas.errorMessage).toBe(
          "No hay ventas entregadas para este agricultor en el periodo.",
        );
      }
    },
    T,
  );

  test(
    "L8 pago idempotente: dispersión fk_pedido NULL con folio de pago, replay → mismo detalle y PG sin cambios; datos distintos → 409; sin recibo",
    async () => {
      const fila = await pgUna<{ id: string }>(
        "select id from liquidacion where fk_agricultor = $1 and estado = 'pendiente' order by creado_en desc limit 1",
        [farmerId],
      );
      const pagosAntes = await pgUna<{ n: number }>(
        "select count(*)::int n from pago where fk_pedido is null and fk_tipo_pago = $1 and referencia = $2",
        [idEfectivo, referencia],
      );

      const primera = await marcarPagada({ id: fila.id, fkTipoPago: idEfectivo, referencia });
      expect(primera.ok).toBe(true);
      if (!primera.ok) return;
      expect(primera.data.estado).toBe("pagada");
      expect(primera.data.folioPago).toMatch(/^R-\d{6}$/);
      expect(primera.data.pago?.monto).toBe(primera.data.montoLiquidar);
      expect(primera.data.pago?.tipoPagoNombre).toBe("Efectivo");

      // The dispersion pago is fk_pedido NULL (legacy parity — database.md §4.2) and
      // NO recibo is created (legacy marcar_pagada never makes one).
      const dispersion = await pgUna<{ n: number; pedido: string | null }>(
        `select count(*)::int n, (select fk_pedido::text from pago where folio = $1) pedido from pago where folio = $1`,
        [primera.data.folioPago!],
      );
      expect(dispersion.n).toBe(1);
      expect(dispersion.pedido).toBeNull();
      const recibo = await pgUna<{ n: number }>(
        "select count(*)::int n from recibo where folio = $1",
        [primera.data.folioPago!],
      );
      expect(recibo.n).toBe(0);

      // REPLAY with the same tipo + referencia → 200, same detail; PG gains NOTHING.
      const replay = await marcarPagada({ id: fila.id, fkTipoPago: idEfectivo, referencia });
      expect(replay.ok).toBe(true);
      if (replay.ok) {
        expect(replay.data.id).toBe(primera.data.id);
        expect(replay.data.folioPago).toBe(primera.data.folioPago);
      }
      const pagosDespues = await pgUna<{ n: number }>(
        "select count(*)::int n from pago where fk_pedido is null and fk_tipo_pago = $1 and referencia = $2",
        [idEfectivo, referencia],
      );
      expect(pagosDespues.n).toBe(pagosAntes.n + 1); // exactly ONE dispersion pago total

      // Distinct referencia → 409 with the legacy message (folio included).
      const distinta = await marcarPagada({
        id: fila.id,
        fkTipoPago: idEfectivo,
        referencia: `${referencia}-x`,
      });
      expect(distinta.ok).toBe(false);
      if (!distinta.ok) {
        expect(distinta.status).toBe(409);
        expect(distinta.errorMessage).toBe(
          `La liquidación ya fue pagada previamente con datos distintos (Folio: ${primera.data.folioPago}). No se puede modificar el pago.`,
        );
      }
      // Distinct tipo → 409 too.
      const otroTipo = await marcarPagada({ id: fila.id, fkTipoPago: idTransferencia, referencia });
      expect(otroTipo.ok).toBe(false);
      if (!otroTipo.ok) expect(otroTipo.status).toBe(409);

      // L7 applies to the PAID state: re-calculating the paid period → 409.
      const recalculo = await calcular({ agricultor: farmerId, semana, anio });
      expect(recalculo.ok).toBe(false);
      if (!recalculo.ok) expect(recalculo.status).toBe(409);
    },
    T,
  );

  test(
    "operationId idempotente: veredicto rechazada almacenado y reproducido (mismo motivo, sin filas nuevas)",
    async () => {
      const operationId = crypto.randomUUID();
      const rechazo = await calcular({ agricultor: farmerVacioId, semana, anio, operationId });
      expect(rechazo.ok).toBe(false);
      if (!rechazo.ok) {
        expect(rechazo.status).toBe(400);
        expect(rechazo.errorMessage).toBe(
          "No hay ventas entregadas para este agricultor en el periodo.",
        );
      }
      // REPLAY: same id → same stored verdict, no effects re-executed.
      const rechazoReplay = await calcular({
        agricultor: farmerVacioId,
        semana,
        anio,
        operationId,
      });
      expect(rechazoReplay.ok).toBe(false);
      if (!rechazoReplay.ok) {
        expect(rechazoReplay.status).toBe(400);
        expect(rechazoReplay.errorMessage).toBe(
          "No hay ventas entregadas para este agricultor en el periodo.",
        );
      }
      const ops = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_operacion where id = $1 and veredicto = 'rechazada'",
        [operationId],
      );
      expect(ops.n).toBe(1);
    },
    T,
  );

  test(
    "scoping: Vendedor/Agricultor/Cliente 403 en listar/detalle/calcular/marcarPagada; Admin sí consulta",
    async () => {
      const fila = await pgUna<{ id: string }>(
        "select id from liquidacion where fk_agricultor = $1 order by creado_en desc limit 1",
        [farmerId],
      );
      for (const token of [vendedorToken, agroToken, clienteToken]) {
        const l = await trpc("query", "liquidaciones.listar", {}, token);
        expect(l.ok).toBe(false);
        if (!l.ok) expect(l.status).toBe(403);
        const d = await trpc("query", "liquidaciones.detalle", { id: fila.id }, token);
        expect(d.ok).toBe(false);
        if (!d.ok) expect(d.status).toBe(403);
        const c = await calcular(
          { agricultor: farmerId, semana: semanaSiguiente, anio: anioSiguiente },
          token,
        );
        expect(c.ok).toBe(false);
        if (!c.ok) expect(c.status).toBe(403);
        const p = await marcarPagada({ id: fila.id, fkTipoPago: idEfectivo }, token);
        expect(p.ok).toBe(false);
        if (!p.ok) expect(p.status).toBe(403);
      }
      const adminLista = await trpc<LiquidacionDto[]>(
        "query",
        "liquidaciones.listar",
        {},
        adminToken,
      );
      expect(adminLista.ok).toBe(true);
      if (adminLista.ok) expect(adminLista.data.some((l) => l.id === fila.id)).toBe(true);
    },
    T,
  );

  test(
    "outbox M-1a: liquidacion insert + N liquidacion_venta inserts + pago insert + liquidacion update",
    async () => {
      const filas = await pgQuery<{ tabla_origen: string; operacion: string }>(
        `select sc.tabla_origen, sc.operacion
         from sync_cambio sc
         where (sc.tabla_origen = 'liquidacion' and sc.id_fila in (select id from liquidacion where fk_agricultor = $1))
            or (sc.tabla_origen = 'liquidacion_venta' and sc.id_fila in (select lv.id from liquidacion_venta lv join liquidacion l on l.id = lv.fk_liquidacion where l.fk_agricultor = $1))
            or (sc.tabla_origen = 'pago' and sc.id_fila in (select l.fk_pago_liquidacion from liquidacion l where l.fk_agricultor = $1 and l.fk_pago_liquidacion is not null))
         order by sc.tabla_origen, sc.operacion`,
        [farmerId],
      );
      expect(
        filas.filter((f) => f.tabla_origen === "liquidacion" && f.operacion === "insert").length,
      ).toBe(1);
      expect(
        filas.filter((f) => f.tabla_origen === "liquidacion_venta" && f.operacion === "insert")
          .length,
      ).toBe(2);
      expect(
        filas.filter((f) => f.tabla_origen === "liquidacion" && f.operacion === "update").length,
      ).toBe(1);
      expect(
        filas.filter((f) => f.tabla_origen === "pago" && f.operacion === "insert").length,
      ).toBe(1);
    },
    T,
  );

  test(
    "validación: agricultor inexistente/no-agricultor/inactivo, semana inexistente, rangos → 400; tipo_pago inexistente → 400 ANTES de la fila; liquidación inexistente → 404",
    async () => {
      const inexistente = await calcular({ agricultor: crypto.randomUUID(), semana, anio });
      expect(inexistente.ok).toBe(false);
      if (!inexistente.ok) {
        expect(inexistente.status).toBe(400);
        expect(inexistente.errorMessage).toBe("El agricultor no existe.");
      }
      const idVendedor = (
        await pgUna<{ id: string }>("select id from usuario where correo = $1", [VENDEDOR])
      ).id;
      const noAgro = await calcular({ agricultor: idVendedor, semana, anio });
      expect(noAgro.ok).toBe(false);
      if (!noAgro.ok)
        expect(noAgro.errorMessage).toBe("El usuario indicado no tiene rol Agricultor.");

      // Inactive agricultor (flip the empty fixture farmer; restore right after).
      await pgQuery("update usuario set estado = false where id = $1", [farmerVacioId]);
      const inactivo = await calcular({
        agricultor: farmerVacioId,
        semana: semanaSiguiente,
        anio: anioSiguiente,
      });
      expect(inactivo.ok).toBe(false);
      if (!inactivo.ok) expect(inactivo.errorMessage).toBe("El agricultor está inactivo.");
      await pgQuery("update usuario set estado = true where id = $1", [farmerVacioId]);

      // 2025 has 52 ISO weeks: 53 does not exist (legacy date.fromisocalendar parity).
      const semanaMala = await calcular({ agricultor: farmerId, semana: 53, anio: 2025 });
      expect(semanaMala.ok).toBe(false);
      if (!semanaMala.ok) {
        expect(semanaMala.status).toBe(400);
        expect(semanaMala.errorMessage).toBe("La semana 53 no existe para el año 2025.");
      }
      const semanaFuera = await calcular({ agricultor: farmerId, semana: 54, anio });
      expect(semanaFuera.ok).toBe(false);
      if (!semanaFuera.ok) expect(semanaFuera.status).toBe(400);
      const anioFuera = await calcular({ agricultor: farmerId, semana, anio: 1999 });
      expect(anioFuera.ok).toBe(false);
      if (!anioFuera.ok) expect(anioFuera.status).toBe(400);

      // tipo_pago inexistente → 400 BEFORE the row lookup (legacy serializer ordering);
      // liquidación inexistente (valid tipo) → 404.
      const tipoMalo = await marcarPagada({
        id: crypto.randomUUID(),
        fkTipoPago: crypto.randomUUID(),
      });
      expect(tipoMalo.ok).toBe(false);
      if (!tipoMalo.ok) {
        expect(tipoMalo.status).toBe(400);
        expect(tipoMalo.errorMessage).toBe("El tipo de pago no existe.");
      }
      const liqInexistente = await marcarPagada({
        id: crypto.randomUUID(),
        fkTipoPago: idEfectivo,
      });
      expect(liqInexistente.ok).toBe(false);
      if (!liqInexistente.ok) {
        expect(liqInexistente.status).toBe(404);
        expect(liqInexistente.errorMessage).toBe("Liquidación no encontrada.");
      }
    },
    T,
  );

  test(
    "C1 exclusión entre periodos: un pedido ya liquidado queda EXCLUIDO de cualquier cálculo futuro (harness de fechas retroactivas, paridad del legacy test_calcular_bajo_concurrencia_con_pedidos_disjuntos)",
    async () => {
      // Per-run farmer + delivered order in the CURRENT week: it is liquidated this run.
      const c1 = await crearFarmerConItems(
        `e2e-liqc1-${sufijo()}@fixture.local`,
        `FarmerC1${sufijo()}`,
      );
      const p = await crearPedidoEntregado([{ fkProductoSemanal: c1.itemA, cantidad: 1 }]);
      if (!p) return;
      const actual = await calcular({ agricultor: c1.farmerId, semana, anio });
      expect(actual.ok).toBe(true);
      if (!actual.ok) return;
      expect(actual.data.ventas.map((v) => v.fkPedido)).toEqual([p.id]);

      // SQL-fixture time travel (justified: no v2 API lane backdates creado_en —
      // the legacy test does exactly this with .update(creado_en=...)). Rows are
      // per-run (fresh farmer/order), so re-runs never collide; the original value is
      // restored afterwards to leave no drift.
      // test:
      const original = await pgUna<{ creadoEn: string }>(
        'select creado_en::text as "creadoEn" from pedido_cabecera where id = $1',
        [p.id],
      );
      const lunesPasado = mondayOfBusinessWeek(new Date());
      lunesPasado.setUTCDate(lunesPasado.getUTCDate() - 7);
      try {
        // Noon Mazatlan of last Monday (UTC-6): squarely inside last week's window.
        await pgQuery("update pedido_cabecera set creado_en = $1 where id = $2", [
          `${lunesPasado.toISOString().slice(0, 10)}T18:00:00Z`,
          p.id,
        ]);

        // The order's creado_en now sits INSIDE last week's window, but it was already
        // liquidated (liquidacion_venta row exists) → the C1 predicate excludes it:
        // the last-week calculation finds ZERO un-liquidated ventas → legacy 400,
        // and NO second liquidación row is created (no double payment).
        const { semanaIso: semanaAnterior, anioIso: anioAnterior } = isoWeekFromMonday(lunesPasado);
        const pasada = await calcular({
          agricultor: c1.farmerId,
          semana: semanaAnterior,
          anio: anioAnterior,
        });
        expect(pasada.ok).toBe(false);
        if (!pasada.ok) {
          expect(pasada.status).toBe(400);
          expect(pasada.errorMessage).toBe(
            "No hay ventas entregadas para este agricultor en el periodo.",
          );
        }
        const n = (
          await pgUna<{ n: number }>(
            "select count(*)::int n from liquidacion where fk_agricultor = $1",
            [c1.farmerId],
          )
        ).n;
        expect(n).toBe(1);
      } finally {
        await pgQuery("update pedido_cabecera set creado_en = $1 where id = $2", [
          original.creadoEn,
          p.id,
        ]);
      }
    },
    T,
  );
});
