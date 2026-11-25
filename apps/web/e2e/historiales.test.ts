import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import { limitesDiaNegocio } from "@rassa-jala/db/estados-corte";
import { aFechaCiclo, hoyNegocio, mondayOfBusinessWeek } from "@rassa-jala/db/iso-semana";

import {
  ADMIN,
  AGRO,
  AGRO2,
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

// P1-F Historiales y reportes operativos e2e (docs/roadmap.md §6 P1-F; gap 18).
// Proofs:
// - historialPedido / historialRecoleccion: chronological rows (fecha asc),
//   previous state derived from the prior row, ACTOR ATTRIBUTION with the
//   resolved person NAME (legacy cambiado_por_nombre parity).
// - Scoping: cliente own / vendedor assigned / admin all; Agricultor 403 and
//   foreign data 403; recolección agricultor-own-only and Cliente 403.
// - resumenMermas (legacy MermaResumenView, Admin-only): aggregates compared
//   against DIRECT SQL over the same rows (mes/semana groupings, global total,
//   top product, maestro-product filter) — aggregate-vs-SQL style like the
//   dashboard suite. Mermas are created via the real API (admin) on a real
//   order, never injected directly.
// Re-run safe ×2: per-run SQL fixtures with dynamic suffixes; nothing deleted.

type HistorialFila = {
  id: string;
  estadoAnterior: string | null;
  estadoNuevo: string;
  actor: string | null;
  fecha: string;
};

type ResumenMermas = {
  agrupacion: string;
  totalGeneral: number;
  productoMasAfectado: { nombre: string; total: number } | null;
  detalle: Array<{
    periodo: string;
    productoNombre: string;
    productoId: string;
    decisionNombre: string;
    decisionId: string;
    totalCantidad: number;
    totalMermas: number;
  }>;
};

type PedidoDto = { id: string; version: number; total: string };

type TiempoEntrega = {
  dias: number;
  pedidosEntregados: number;
  promedioHoras: number | null;
};

/** SQL fixture user (admin's hash → logs in with DEV_PASSWORD), re-run safe. */
async function crearUsuarioFixture(correo: string, nombre: string, rol: string): Promise<string> {
  const localidad = await pgUna<{ id: string }>(
    "select id from localidad where nombre = 'Tepic' and estado order by id limit 1",
  );
  const personaId = crypto.randomUUID();
  await pgQuery(
    `insert into persona (id, nombre, apellido_paterno, fk_localidad)
     values ($1, $2, 'Historial', $3)
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

/** Full display name (persona) of a user, via direct SQL — the actor expectation. */
async function nombreUsuario(correo: string): Promise<string> {
  const fila = await pgUna<{ nombre: string }>(
    `select trim(p.nombre || ' ' || p.apellido_paterno) nombre
     from usuario u join persona p on p.id = u.fk_persona where u.correo = $1`,
    [correo],
  );
  return fila.nombre;
}

describe("historiales e2e (p1-historiales proofs)", () => {
  let adminToken = "";
  let vendedorSeedToken = "";
  let agroToken = "";
  let agro2Token = "";
  let clienteSeedToken = "";
  let vendFixToken = "";
  let agroFixToken = "";
  let clienteFixToken = "";
  let itemMoneyId = "";
  let pedidoPresencialId = "";
  let pedidoClienteId = "";
  let recoleccionId = "";
  const s = sufijo();
  const correoVend = `e2e-hist-vend-${s}@fixture.local`;
  const correoAgro = `e2e-hist-agro-${s}@fixture.local`;
  const correoCliente = `e2e-hist-cli-${s}@fixture.local`;

  beforeAll(async () => {
    await ensureServer();
    await ensureFixtures();
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
    vendedorSeedToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    agro2Token = await tokenDe(AGRO2, DEV_PASSWORD);
    clienteSeedToken = await tokenDe(CLIENTE, DEV_PASSWORD);

    const fixtures = await ensureFixtures();
    itemMoneyId = fixtures.itemMoneyId; // precio 10.13, stock 1000

    // Per-run actors with KNOWN display names (actor-attribution proofs).
    await crearUsuarioFixture(correoVend, `VendHist${s}`, "Vendedor");
    vendFixToken = await tokenDe(correoVend, DEV_PASSWORD);
    await crearUsuarioFixture(correoAgro, `AgroHist${s}`, "Agricultor");
    agroFixToken = await tokenDe(correoAgro, DEV_PASSWORD);

    // Fresh Cliente + personal credit limit (Q-10: sin límite → sin pedidos) so
    // the cliente-own scoping proof has a real own order (checkout by API).
    await crearUsuarioFixture(correoCliente, `CliHist${s}`, "Cliente");
    clienteFixToken = await tokenDe(correoCliente, DEV_PASSWORD);
    const clienteId = await pgUna<{ id: string }>("select id from usuario where correo = $1", [
      correoCliente,
    ]);
    await pgQuery(
      `insert into limite_credito (id, monto, fk_usuario) values (gen_random_uuid(), 500, $1)`,
      [clienteId.id],
    );

    // Real order 1 — presencial by the fresh vendedor (fk_vendedor = self),
    // then CANCELLED by the Admin so the log gains a second distinct actor.
    // One line from the FIXTURE farmer's publication only (itemOtro belongs to
    // farmer2): dashboard.test.ts's merma SQL parity joins per matching farmer
    // line, so a single-farmer-line order keeps both counts equal.
    const pedidoPresencial = await trpc<PedidoDto>(
      "mutation",
      "pedidos.pedidoPresencial",
      {
        clienteNombre: `Cliente Historial ${s}`,
        items: [
          { fkProductoSemanal: itemMoneyId, cantidad: 2 },
          { fkProductoSemanal: fixtures.itemOtroId, cantidad: 3 },
        ],
      },
      vendFixToken,
    );
    expect(pedidoPresencial.ok).toBe(true);
    if (!pedidoPresencial.ok) throw new Error(pedidoPresencial.errorMessage);
    pedidoPresencialId = pedidoPresencial.data.id;
    const cancelado = await trpc(
      "mutation",
      "pedidos.cancelar",
      { pedidoId: pedidoPresencialId, version: pedidoPresencial.data.version },
      adminToken,
    );
    expect(cancelado.ok).toBe(true);

    // Real order 2 — fresh Cliente's own checkout (unclaimed digital order).
    const pedidoCliente = await trpc<PedidoDto>(
      "mutation",
      "pedidos.checkout",
      { items: [{ fkProductoSemanal: itemMoneyId, cantidad: 1 }] },
      clienteFixToken,
    );
    expect(pedidoCliente.ok).toBe(true);
    if (!pedidoCliente.ok) throw new Error(pedidoCliente.errorMessage);
    pedidoClienteId = pedidoCliente.data.id;

    // Real recolección for the fresh agricultor (fresh user → free slot).
    const rec = await trpc<{ id: string }>(
      "mutation",
      "recolecciones.crear",
      {
        fkAgricultor: (
          await pgUna<{ id: string }>("select id from usuario where correo = $1", [correoAgro])
        ).id,
        fechaRecoleccion: "2027-06-15",
      },
      vendFixToken,
    );
    expect(rec.ok).toBe(true);
    if (!rec.ok) throw new Error(rec.errorMessage);
    recoleccionId = rec.data.id;

    // Real mermas via the API (admin may use any pedido): two lines of the
    // cancelled presencial order — the aggregate proofs below read these.
    const decisiones = await trpc<Array<{ id: string; decision: string }>>(
      "query",
      "mermas.decisiones.listar",
      {},
      adminToken,
    );
    expect(decisiones.ok).toBe(true);
    if (!decisiones.ok) throw new Error(decisiones.errorMessage);
    const donar = decisiones.data.find((d) => d.decision === "Donar");
    const desechar = decisiones.data.find((d) => d.decision === "Desechar");
    if (!donar || !desechar) throw new Error("decisiones del seed no encontradas");
    for (const entrada of [
      { fkProductoSemanal: itemMoneyId, cantidad: 1, fkDecision: donar.id },
      { fkProductoSemanal: itemMoneyId, cantidad: 2, fkDecision: donar.id },
      { fkProductoSemanal: fixtures.itemOtroId, cantidad: 3, fkDecision: desechar.id },
    ]) {
      const res = await trpc(
        "mutation",
        "mermas.registrar",
        { fkPedido: pedidoPresencialId, motivo: "Resumen historiales QA", ...entrada },
        adminToken,
      );
      expect(res.ok).toBe(true);
    }
  }, T);

  test(
    "historialPedido: cronológico, estadoAnterior derivado y actor con nombre (legacy parity)",
    async () => {
      const historial = await trpc<HistorialFila[]>(
        "query",
        "historiales.historialPedido",
        { id: pedidoPresencialId },
        adminToken,
      );
      expect(historial.ok).toBe(true);
      if (!historial.ok) return;
      const filas = historial.data;
      expect(filas.length).toBeGreaterThanOrEqual(2);

      // Chronological (legacy order_by creado_en): each fecha >= previous.
      for (let i = 1; i < filas.length; i += 1) {
        expect(filas[i]!.fecha >= filas[i - 1]!.fecha).toBe(true);
      }

      const actorEsperado = await nombreUsuario(correoVend);
      const primera = filas[0]!;
      expect(primera.estadoNuevo).toBe("pendiente");
      expect(primera.estadoAnterior).toBeNull();
      expect(primera.actor).toBe(actorEsperado);

      // The admin-cancelled order: the LAST row carries the admin's name.
      const ultima = filas[filas.length - 1]!;
      expect(ultima.estadoNuevo).toBe("cancelado");
      expect(ultima.estadoAnterior).toBe("pendiente");
      expect(ultima.actor).toBe(await nombreUsuario(ADMIN));
    },
    T,
  );

  test(
    "scoping historialPedido: cliente propio 200, vendedor ajeno/agricultor/cliente ajeno 403",
    async () => {
      // Cliente OWN order reads its own log (first row = pendiente by itself).
      const propia = await trpc<HistorialFila[]>(
        "query",
        "historiales.historialPedido",
        { id: pedidoClienteId },
        clienteFixToken,
      );
      expect(propia.ok).toBe(true);
      if (propia.ok) {
        expect(propia.data[0]?.estadoNuevo).toBe("pendiente");
        expect(propia.data[0]?.actor).toBe(await nombreUsuario(correoCliente));
      }

      // Foreign data / wrong roles → 403 (uniform v2 deviation from the legacy
      // 404, same as pedidos.detalle).
      for (const [token, pedidoId] of [
        [clienteSeedToken, pedidoPresencialId],
        [agroToken, pedidoPresencialId],
        [vendFixToken, pedidoClienteId],
        [vendedorSeedToken, pedidoClienteId],
      ] as Array<[string, string]>) {
        const res = await trpc("query", "historiales.historialPedido", { id: pedidoId }, token);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errorCode).toBe("FORBIDDEN");
      }
    },
    T,
  );

  test(
    "historialRecoleccion: cronológico + actor; scoping agricultor propio / ajeno / cliente",
    async () => {
      const historial = await trpc<HistorialFila[]>(
        "query",
        "historiales.historialRecoleccion",
        { id: recoleccionId },
        adminToken,
      );
      expect(historial.ok).toBe(true);
      if (!historial.ok) return;
      expect(historial.data.length).toBeGreaterThanOrEqual(1);
      const primera = historial.data[0]!;
      expect(primera.estadoAnterior).toBeNull();
      expect(primera.estadoNuevo).toBe("pendiente");
      expect(primera.actor).toBe(await nombreUsuario(correoVend));

      // Positives: the owning agricultor and any vendedor read it.
      for (const token of [agroFixToken, vendFixToken]) {
        const res = await trpc(
          "query",
          "historiales.historialRecoleccion",
          { id: recoleccionId },
          token,
        );
        expect(res.ok).toBe(true);
      }
      // Negatives: ANOTHER agricultor and any Cliente.
      for (const token of [agro2Token, clienteSeedToken]) {
        const res = await trpc(
          "query",
          "historiales.historialRecoleccion",
          { id: recoleccionId },
          token,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errorCode).toBe("FORBIDDEN");
      }
    },
    T,
  );

  test(
    "resumenMermas: agregados (mes y semana) contra SQL directo",
    async () => {
      // SQL rows in the SAME instant window the server used (no dates →
      // only the estado=true + optional product filters).
      const filas = await pgQuery<{
        cantidad: number;
        creadoEn: Date;
        decisionId: string;
        decisionNombre: string;
        productoId: string | null;
        productoNombre: string | null;
      }>(
        `select m.cantidad, m.creado_en "creadoEn", d.id "decisionId", d.decision "decisionNombre",
                ps.fk_producto "productoId", p.nombre "productoNombre"
         from merma m
         join decision_merma d on d.id = m.fk_decision
         left join producto_semanal ps on ps.id = m.fk_producto_semanal
         left join producto p on p.id = ps.fk_producto
         where m.estado`,
      );

      // JS mirror of the legacy semantics (Mazatlan wall calendar).
      const mesDe = (inst: Date): string => `${hoyNegocio(inst).slice(0, 7)}-01`;
      const semanaDe = (inst: Date): string => aFechaCiclo(mondayOfBusinessWeek(inst));

      const comparar = async (agruparPor: "mes" | "semana") => {
        const periodoDe = agruparPor === "mes" ? mesDe : semanaDe;
        const resumen = await trpc<ResumenMermas>(
          "query",
          "historiales.resumenMermas",
          { agruparPor },
          adminToken,
        );
        expect(resumen.ok).toBe(true);
        if (!resumen.ok) return;
        const r = resumen.data;

        // total_general over ALL estado rows (legacy aggregate, orphans included).
        const sqlTotal = filas.reduce((acc, f) => acc + f.cantidad, 0);
        expect(r.totalGeneral).toBe(sqlTotal);

        // Groups over rows WITH product (legacy values()/annotate semantics).
        const sqlGrupos = new Map<string, { totalCantidad: number; totalMermas: number }>();
        const porProducto = new Map<string, number>();
        for (const f of filas) {
          if (!f.productoId || !f.productoNombre) continue;
          const llave = `${periodoDe(f.creadoEn)}|${f.productoId}|${f.decisionId}`;
          const g = sqlGrupos.get(llave) ?? { totalCantidad: 0, totalMermas: 0 };
          g.totalCantidad += f.cantidad;
          g.totalMermas += 1;
          sqlGrupos.set(llave, g);
          porProducto.set(f.productoNombre, (porProducto.get(f.productoNombre) ?? 0) + f.cantidad);
        }
        expect(r.detalle.length).toBe(sqlGrupos.size);
        for (const g of r.detalle) {
          const llave = `${g.periodo}|${g.productoId}|${g.decisionId}`;
          const esperado = sqlGrupos.get(llave);
          if (!esperado) throw new Error(`grupo sin paridad SQL: ${llave}`);
          expect(g.totalCantidad).toBe(esperado.totalCantidad);
          expect(g.totalMermas).toBe(esperado.totalMermas);
        }

        // producto_mas_afectado: max total, name-asc tie-break (legacy order).
        let esperadoTop: { nombre: string; total: number } | null = null;
        for (const [nombre, total] of porProducto) {
          if (
            esperadoTop === null ||
            total > esperadoTop.total ||
            (total === esperadoTop.total && nombre < esperadoTop.nombre)
          ) {
            esperadoTop = { nombre, total };
          }
        }
        expect(r.productoMasAfectado).toEqual(esperadoTop);
      };

      await comparar("mes");
      await comparar("semana");

      // Legacy producto_id filter: maestro producto of itemMoney (via SQL).
      const chile = await pgUna<{ id: string }>(
        "select fk_producto id from producto_semanal where id = $1",
        [itemMoneyId],
      );
      const filtrado = await trpc<ResumenMermas>(
        "query",
        "historiales.resumenMermas",
        { fkProducto: chile.id },
        adminToken,
      );
      expect(filtrado.ok).toBe(true);
      if (filtrado.ok) {
        const sqlFiltrado = filas.filter((f) => f.productoId === chile.id);
        expect(filtrado.data.totalGeneral).toBe(
          sqlFiltrado.reduce((acc, f) => acc + f.cantidad, 0),
        );
        for (const g of filtrado.data.detalle) expect(g.productoId).toBe(chile.id);
      }

      // Legacy limit 100 on the detail slice.
      expect(filtrado.ok && filtrado.data.detalle.length <= 100).toBe(true);
    },
    T,
  );

  test(
    "resumenMermas: solo Admin (403s) y validaciones legacy (agrupación, rango de fechas)",
    async () => {
      for (const token of [vendedorSeedToken, agroToken, clienteSeedToken]) {
        const res = await trpc("query", "historiales.resumenMermas", { agruparPor: "mes" }, token);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errorCode).toBe("FORBIDDEN");
      }
      // agrupar_por invalid (legacy _parse_agrupar_por → ValidationError).
      const agrupacion = await trpc(
        "query",
        "historiales.resumenMermas",
        { agruparPor: "anio" },
        adminToken,
      );
      expect(agrupacion.ok).toBe(false);
      if (!agrupacion.ok) expect(agrupacion.errorCode).toBe("BAD_REQUEST");

      // Legacy cross-field check with the exact message.
      const rango = await trpc(
        "query",
        "historiales.resumenMermas",
        { fechaDesde: "2026-01-02", fechaHasta: "2026-01-01" },
        adminToken,
      );
      expect(rango.ok).toBe(false);
      if (!rango.ok) {
        expect(rango.errorCode).toBe("BAD_REQUEST");
        expect(rango.errorMessage).toContain("fecha_desde no puede ser mayor a fecha_hasta.");
      }

      // Date-window filter is honored: a past empty range reads all zeros
      // (real zeros — CERO simulated data).
      const vacio = await trpc<ResumenMermas>(
        "query",
        "historiales.resumenMermas",
        { fechaDesde: "2020-01-01", fechaHasta: "2020-01-02" },
        adminToken,
      );
      expect(vacio.ok).toBe(true);
      if (vacio.ok) {
        expect(vacio.data.totalGeneral).toBe(0);
        expect(vacio.data.detalle).toEqual([]);
        expect(vacio.data.productoMasAfectado).toBeNull();
      }

      // Sanity: limitesDiaNegocio bounds the window the same way the server does.
      const { inicio } = limitesDiaNegocio("2020-01-01");
      expect(inicio.toISOString()).toBeDefined();
    },
    T,
  );

  test(
    "tiempoEntrega: promedio confirmado→entregado de los pedidos entregados en la ventana, vs SQL directo; solo Admin",
    async () => {
      // Two REAL delivered orders through the API lanes: presencial checkout →
      // registrarPago (auto-advance confirmado) → marcarEntregado (entregado).
      // There is no v2 lane that edits those transitions' instants, so the exact
      // durations are then set via SQL time travel on the FRESH per-run rows
      // (fixture-style backdate — liquidaciones C1 parity; nothing shared to
      // restore). Durations: A = 24.0 h, B = 5.0 h.
      const crearEntregado = async (): Promise<string> => {
        const pedido = await trpc<PedidoDto>(
          "mutation",
          "pedidos.pedidoPresencial",
          {
            clienteNombre: `Entrega ${s} ${crypto.randomUUID().slice(0, 8)}`,
            items: [{ fkProductoSemanal: itemMoneyId, cantidad: 1 }],
          },
          vendFixToken,
        );
        expect(pedido.ok).toBe(true);
        if (!pedido.ok) throw new Error(pedido.errorMessage);
        const tipos = await trpc<Array<{ id: string; nombre: string }>>(
          "query",
          "pagos.tiposPago",
          {},
          vendFixToken,
        );
        expect(tipos.ok).toBe(true);
        if (!tipos.ok) throw new Error(tipos.errorMessage);
        const efectivo = tipos.data.find((t) => t.nombre === "Efectivo");
        if (!efectivo) throw new Error("tipo de pago Efectivo no encontrado");
        const pago = await trpc(
          "mutation",
          "pagos.registrarPago",
          { fkPedido: pedido.data.id, fkTipoPago: efectivo.id },
          vendFixToken,
        );
        expect(pago.ok).toBe(true);
        if (!pago.ok) throw new Error(pago.errorMessage);
        const entrega = await trpc(
          "mutation",
          "pagos.marcarEntregado",
          { fkPedido: pedido.data.id },
          adminToken,
        );
        expect(entrega.ok).toBe(true);
        if (!entrega.ok) throw new Error(entrega.errorMessage);
        return pedido.data.id;
      };

      const idsHistorial = async (
        pedidoId: string,
      ): Promise<{ confirmadoId: string; entregadoId: string }> => {
        const filas = await pgQuery<{ id: string; estado: string }>(
          `select hp.id, e.nombre as estado
           from historial_estado_pedido hp join estado_pedido e on e.id = hp.fk_estado
           where hp.fk_pedido = $1`,
          [pedidoId],
        );
        const confirmado = filas.find((f) => f.estado === "confirmado");
        const entregado = filas.find((f) => f.estado === "entregado");
        if (!confirmado || !entregado) throw new Error("historial incompleto en fixture");
        return { confirmadoId: confirmado.id, entregadoId: entregado.id };
      };

      const pedidoA = await crearEntregado();
      const pedidoB = await crearEntregado();

      // Mazatlan business-date anchors: dia(1) = yesterday, dia(2) = two days ago.
      const hoy = hoyNegocio(new Date());
      const dia = (offset: number): string => {
        const d = new Date(`${hoy}T00:00:00.000Z`);
        d.setUTCDate(d.getUTCDate() - offset);
        return d.toISOString().slice(0, 10);
      };
      const a = await idsHistorial(pedidoA);
      const b = await idsHistorial(pedidoB);
      // A confirmed two days ago (OUTSIDE the 2-day window — the first
      // confirmado may predate the delivered window) and delivered yesterday:
      // exactly 24.0 h. B confirmed+delivered yesterday: exactly 5.0 h.
      await pgQuery("update historial_estado_pedido set fecha = $1 where id = $2", [
        `${dia(2)}T18:00:00Z`,
        a.confirmadoId,
      ]);
      await pgQuery("update historial_estado_pedido set fecha = $1 where id = $2", [
        `${dia(1)}T18:00:00Z`,
        a.entregadoId,
      ]);
      await pgQuery("update historial_estado_pedido set fecha = $1 where id = $2", [
        `${dia(1)}T18:00:00Z`,
        b.confirmadoId,
      ]);
      await pgQuery("update historial_estado_pedido set fecha = $1 where id = $2", [
        `${dia(1)}T23:00:00Z`,
        b.entregadoId,
      ]);

      // SQL parity over the SAME predicate the server evaluates: delivered
      // rows in [dia(dias-1), hoy] Mazatlan instants joined to their FIRST
      // confirmado (unbounded — may predate the window). Orders without a
      // confirmado row count in pedidosEntregados but drop from the average.
      const paridad = async (
        dias: number,
      ): Promise<{ pedidosEntregados: number; promedioHoras: number | null }> => {
        const filas = await pgQuery<{
          fechaEntregado: Date;
          fechaConfirmado: Date | null;
        }>(
          `select ent.fecha as "fechaEntregado",
                  (select conf.fecha from historial_estado_pedido conf
                   join estado_pedido ec on ec.id = conf.fk_estado
                   where conf.fk_pedido = ent.fk_pedido and ec.nombre = 'confirmado'
                   order by conf.fecha asc limit 1) as "fechaConfirmado"
           from historial_estado_pedido ent
           join estado_pedido e on e.id = ent.fk_estado
           where e.nombre = 'entregado' and ent.fecha >= $1 and ent.fecha < $2`,
          // [dia(dias-1) 00:00Z, (hoy+1) 00:00Z) — exactly limitesDiaNegocio bounds.
          [dia(dias - 1), dia(-1)],
        );
        const duraciones: number[] = [];
        for (const f of filas) {
          if (f.fechaConfirmado && f.fechaEntregado.getTime() >= f.fechaConfirmado.getTime()) {
            duraciones.push(f.fechaEntregado.getTime() - f.fechaConfirmado.getTime());
          }
        }
        return {
          pedidosEntregados: filas.length,
          promedioHoras:
            duraciones.length === 0
              ? null
              : duraciones.reduce((s, d) => s + d, 0) / duraciones.length / 3_600_000,
        };
      };

      for (const dias of [30, 2]) {
        const esperado = await paridad(dias);
        const res = await trpc<TiempoEntrega>(
          "query",
          "historiales.tiempoEntrega",
          { dias },
          adminToken,
        );
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data.dias).toBe(dias);
        expect(res.data.pedidosEntregados).toBe(esperado.pedidosEntregados);
        // Our two backdated fixtures ride inside the 2-day window.
        if (dias === 2) expect(res.data.pedidosEntregados).toBeGreaterThanOrEqual(2);
        if (esperado.promedioHoras === null) {
          expect(res.data.promedioHoras).toBeNull();
        } else {
          expect(res.data.promedioHoras).not.toBeNull();
          expect(res.data.promedioHoras!).toBeCloseTo(esperado.promedioHoras, 9);
        }
      }

      // Default window (no input) = 30 days.
      const defecto = await trpc<TiempoEntrega>(
        "query",
        "historiales.tiempoEntrega",
        {},
        adminToken,
      );
      expect(defecto.ok).toBe(true);
      if (defecto.ok) expect(defecto.data.dias).toBe(30);

      // Admin-only (403s).
      for (const token of [vendedorSeedToken, agroToken, clienteSeedToken]) {
        const res = await trpc("query", "historiales.tiempoEntrega", {}, token);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errorCode).toBe("FORBIDDEN");
      }
    },
    T,
  );
});
