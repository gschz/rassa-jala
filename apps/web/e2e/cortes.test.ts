import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import { hoyNegocio } from "@rassa-jala/db/iso-semana";

import {
  ADMIN,
  AGRO,
  CLIENTE,
  DEV_PASSWORD,
  VENDEDOR,
  VENDEDOR2,
  ensureFixtures,
  ensureServer,
  pgQuery,
  pgUna,
  sufijo,
  tokenDe,
  trpc,
} from "./helpers";

const T = 240_000;

// P1-A Cortes de caja e2e (docs/roadmap.md §6 P1-A; database.md §3.5/M-15, §4.2
// partial unique, §4.6/§4.7 formula validated 3/3; backend-audit C1-C4). Rules
// extracted from legacy/rassa_back/rassa/blueprints/cortes — never copied:
// - C1: monto_teorico = sum of CASH pagos (tipo 'Efectivo' iexact) of the caller's
//   pedidos within the Mazatlan business day — the server computes it (client CANNOT
//   send it) and the money math is exact integer cents (money.ts).
// - C2: ONE corte per (vendedor, fecha) — advisory lock + pre-check + DB partial
//   unique (`unique_corte_vendedor_fecha`); a racing duplicate is a clean 400.
// - C3: teorico/diferencia are creation-time snapshots; later pagos never
//   retro-update them. diferencia = monto_real - monto_teorico (DB CHECK).
// - Legacy parity: create is ALWAYS for the caller, sets estado='cerrado', and
//   there is NO edit lane — so there is NO CAS 409 proof here (the only conflict is
//   the C2 duplicate → 400, same guard as legacy's IntegrityError → 400).
// - COL23: online-confirm module (M-15) — no RxDB collection; this suite proves the
//   online procedures + DB guarantees directly.

type CorteDto = {
  id: string;
  fkVendedor: string | null;
  vendedorNombre: string | null;
  fecha: string;
  montoTeorico: string;
  montoReal: string;
  diferencia: string;
  estado: string;
  version: number;
};

type TipoPagoDto = { id: string; nombre: string };

/**
 * SQL fixture: a per-run Vendedor (copy of admin's hash → logs in with
 * DEV_PASSWORD). Every test drives THIS user's pedidos/pagos, so the exact-money
 * proofs never collide with other suites' pagos. Upserts keep re-runs convergent.
 */
async function crearVendedorFixture(correo: string, nombre: string): Promise<string> {
  const localidad = await pgUna<{ id: string }>(
    "select id from localidad where nombre = 'Tepic' and estado order by id limit 1",
  );
  const personaId = crypto.randomUUID();
  await pgQuery(
    `insert into persona (id, nombre, apellido_paterno, fk_localidad)
     values ($1, $2, 'Cor', $3)
     on conflict (id) do nothing`,
    [personaId, nombre, localidad.id],
  );
  await pgQuery(
    `insert into usuario (id, correo, password_hash, fk_persona, fk_rol, estado)
     select gen_random_uuid(), $1, u.password_hash, $2, r.id, true
     from usuario u, roles r
     where u.correo = $3 and r.nombre = 'Vendedor'
     on conflict (correo) do nothing`,
    [correo, personaId, ADMIN],
  );
  return (await pgUna<{ id: string }>("select id from usuario where correo = $1", [correo])).id;
}

// Fixed future dates for the uniqueness/idempotency proofs — the vendedor under
// test is created per RUN (sufijo), so these never collide across runs.
const FECHA_RACE = "2027-07-01";
const FECHA_REPLAY = "2027-07-02";
const FECHA_RECHAZO = "2027-07-03";
const FECHA_SCOPING = "2027-07-04";

describe("cortes e2e (p1-cortes proofs)", () => {
  let adminToken = "";
  let vendedorToken = "";
  let agroToken = "";
  let clienteToken = "";
  let vendedor2Token = "";
  // Per-run vendedor: every money proof uses ONLY this user's pagos.
  let vendedorId = "";
  let vendFixToken = "";
  // Fixtures: known-precio items (helpers.ts fixed ids) + the pagos catalog.
  let itemMoneyId = "";
  let itemStockId = "";
  let idEfectivo = "";
  let idTransferencia = "";
  // Business today (Mazatlan) — the day the live pagos land in.
  let hoy = "";

  beforeAll(async () => {
    await ensureServer();
    await ensureFixtures();
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
    vendedorToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    clienteToken = await tokenDe(CLIENTE, DEV_PASSWORD);
    vendedor2Token = await tokenDe(VENDEDOR2, DEV_PASSWORD);
    const s = sufijo();
    const correoFix = `e2e-cortes-${s}@fixture.local`;
    vendedorId = await crearVendedorFixture(correoFix, `VendCor${s}`);
    vendFixToken = await tokenDe(correoFix, DEV_PASSWORD);
    const fixtures = await ensureFixtures();
    itemMoneyId = fixtures.itemMoneyId; // precio 10.13, stock 1000 (re-set every run)
    itemStockId = fixtures.itemStockId; // precio 5.00, stock 10
    const tipos = (
      (await trpc<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken)) as {
        ok: true;
        data: TipoPagoDto[];
      }
    ).data;
    idEfectivo = tipos.find((t) => t.nombre.toLowerCase() === "efectivo")!.id;
    idTransferencia = tipos.find((t) => t.nombre.toLowerCase() === "transferencia")!.id;
    hoy = hoyNegocio(new Date());
  }, 90_000);

  const crearPedidoPresencial = async (
    items: Array<{ fkProductoSemanal: string; cantidad: number }>,
    token = vendFixToken,
  ) =>
    trpc<{ id: string; total: string }>(
      "mutation",
      "pedidos.pedidoPresencial",
      { clienteNombre: `ClienteCortes${sufijo()}`, items },
      token,
    );

  const registrarPago = async (fkPedido: string, fkTipoPago: string, token = vendFixToken) =>
    trpc<{ pagoId: string; monto: string }>(
      "mutation",
      "pagos.registrarPago",
      { fkPedido, fkTipoPago },
      token,
    );

  const crearCorte = async (
    entrada: { montoReal: string; fecha?: string; operationId?: string },
    token = vendFixToken,
  ) => trpc<CorteDto>("mutation", "cortes.crear", entrada, token);

  test(
    "C1 exactitud de la fórmula: 2 pagos en efectivo conocidos → teorico = suma en centavos; transferencia NO cuenta",
    async () => {
      // Known totals via the money proof items (precio 10.13 / 5.00):
      // p1 = 10.13×2 → subtotal 20.26, iva 3.24, total 23.50 (2350 c)
      // p2 = 10.13×1 → subtotal 10.13, iva 1.62, total 11.75 (1175 c)
      // p3 = 5.00×1 → total 5.80 — paid by TRANSFERENCIA: must NOT count.
      const p1 = await crearPedidoPresencial([{ fkProductoSemanal: itemMoneyId, cantidad: 2 }]);
      const p2 = await crearPedidoPresencial([{ fkProductoSemanal: itemMoneyId, cantidad: 1 }]);
      const p3 = await crearPedidoPresencial([{ fkProductoSemanal: itemStockId, cantidad: 1 }]);
      if (!p1.ok || !p2.ok || !p3.ok) {
        console.error(
          "DEBUG fallos:",
          JSON.stringify([p1, p2, p3].filter((p) => !p.ok)).slice(0, 500),
        );
      }
      expect(p1.ok && p2.ok && p3.ok).toBe(true);
      if (!p1.ok || !p2.ok || !p3.ok) return;
      expect(p1.data.total).toBe("23.50");
      expect(p2.data.total).toBe("11.75");

      const pago1 = await registrarPago(p1.data.id, idEfectivo);
      const pago2 = await registrarPago(p2.data.id, idEfectivo);
      const pago3 = await registrarPago(p3.data.id, idTransferencia);
      expect(pago1.ok && pago2.ok && pago3.ok).toBe(true);

      const teorico = await trpc<{ fecha: string; montoTeorico: string }>(
        "query",
        "cortes.teorico",
        { fecha: hoy },
        vendFixToken,
      );
      expect(teorico.ok).toBe(true);
      if (!teorico.ok) return;
      expect(teorico.data.fecha).toBe(hoy);
      expect(teorico.data.montoTeorico).toBe("35.25"); // 23.50 + 11.75; transferencia excluida
    },
    T,
  );

  test(
    "crear: snapshot server-side congelado — teorico/diferencia exactos en centavos, estado 'cerrado', DB CHECK presente",
    async () => {
      const res = await crearCorte({ montoReal: "30.00", fecha: hoy });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.montoTeorico).toBe("35.25");
      expect(res.data.montoReal).toBe("30.00");
      expect(res.data.diferencia).toBe("-5.25"); // 30.00 − 35.25
      expect(res.data.estado).toBe("cerrado");
      expect(res.data.fkVendedor).toBe(vendedorId);

      // Exact cents in PG (the §4.7-validated formula, integer-proofed).
      const fila = await pgUna<{ teorico: string; real: string; dif: string }>(
        `select (monto_teorico*100)::bigint::text teorico, (monto_real*100)::bigint::text real,
                (diferencia*100)::bigint::text dif
         from corte where id = $1`,
        [res.data.id],
      );
      expect(fila.teorico).toBe("3525");
      expect(fila.real).toBe("3000");
      expect(fila.dif).toBe("-525");

      // The CHECK (corte_diferencia_snapshot) is really in the catalog (SELECT proof).
      const check = await pgUna<{ n: number }>(
        `select count(*)::int n from pg_constraint where conname = 'corte_diferencia_snapshot'
         and conrelid = 'corte'::regclass and pg_get_constraintdef(oid) like '%diferencia%'`,
      );
      expect(check.n).toBe(1);
    },
    T,
  );

  test(
    "C3 snapshot congelado: un pago en efectivo POSTERIOR no muta el corte (el endpoint teorico sí lo ve)",
    async () => {
      // Another cash pago AFTER the corte was created (11.75 more).
      const p4 = await crearPedidoPresencial([{ fkProductoSemanal: itemMoneyId, cantidad: 1 }]);
      expect(p4.ok).toBe(true);
      if (!p4.ok) return;
      const pago = await registrarPago(p4.data.id, idEfectivo);
      expect(pago.ok).toBe(true);

      const corte = await pgUna<{ teorico: string }>(
        `select (monto_teorico*100)::bigint::text teorico from corte where fk_vendedor_id = $1 and fecha = $2`,
        [vendedorId, hoy],
      );
      expect(corte.teorico).toBe("3525"); // frozen at creation

      const teorico = await trpc<{ montoTeorico: string }>(
        "query",
        "cortes.teorico",
        { fecha: hoy },
        vendFixToken,
      );
      expect(teorico.ok).toBe(true);
      if (teorico.ok) expect(teorico.data.montoTeorico).toBe("47.00"); // 3525 + 1175
    },
    T,
  );

  test(
    "C2 carrera: dos creates concurrentes del mismo (vendedor, fecha) → 1 gana, 1 → 400 legacy; count=1",
    async () => {
      const resultados = await Promise.all([
        crearCorte({ montoReal: "10.00", fecha: FECHA_RACE }),
        crearCorte({ montoReal: "10.00", fecha: FECHA_RACE }),
      ]);
      const exitos = resultados.filter((r) => r.ok).length;
      expect(exitos).toBe(1);
      const perdedor = resultados.find((r) => !r.ok);
      if (perdedor && !perdedor.ok) {
        expect(perdedor.status).toBe(400);
        expect(perdedor.errorMessage).toBe(`Ya existe un corte para la fecha ${FECHA_RACE}.`);
      }
      const n = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from corte where fk_vendedor_id = $1 and fecha = $2",
          [vendedorId, FECHA_RACE],
        )
      ).n;
      expect(n).toBe(1);
    },
    T,
  );

  test(
    "C2 secuencial: segundo create de la misma fecha → 400 con el mensaje legacy",
    async () => {
      const dup = await crearCorte({ montoReal: "1.00", fecha: hoy });
      expect(dup.ok).toBe(false);
      if (!dup.ok) {
        expect(dup.status).toBe(400);
        expect(dup.errorMessage).toBe(`Ya existe un corte para la fecha ${hoy}.`);
      }
    },
    T,
  );

  test(
    "replay idempotente (aplicada y rechazada): mismo operationId → mismo veredicto, PG counts sin cambios",
    async () => {
      const operationId = crypto.randomUUID();
      const primera = await crearCorte({
        montoReal: "20.00",
        fecha: FECHA_REPLAY,
        operationId,
      });
      expect(primera.ok).toBe(true);
      if (!primera.ok) return;

      const replay = await crearCorte({
        montoReal: "20.00",
        fecha: FECHA_REPLAY,
        operationId,
      });
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.data.id).toBe(primera.data.id);

      // Rejected lane: take FECHA_RECHAZO first, then a create WITH operationId gets
      // a rejected verdict stored; its replay returns the SAME verdict, no effects.
      const ocupada = await crearCorte({ montoReal: "5.00", fecha: FECHA_RECHAZO });
      expect(ocupada.ok).toBe(true);
      const operationIdR = crypto.randomUUID();
      const rechazo = await crearCorte({
        montoReal: "5.00",
        fecha: FECHA_RECHAZO,
        operationId: operationIdR,
      });
      expect(rechazo.ok).toBe(false);
      if (!rechazo.ok) {
        expect(rechazo.status).toBe(400);
        expect(rechazo.errorMessage).toBe(`Ya existe un corte para la fecha ${FECHA_RECHAZO}.`);
      }
      // REPLAY of the rejected id: same verdict, no effects re-executed.
      const rechazoReplay = await crearCorte({
        montoReal: "5.00",
        fecha: FECHA_RECHAZO,
        operationId: operationIdR,
      });
      expect(rechazoReplay.ok).toBe(false);
      if (!rechazoReplay.ok) {
        expect(rechazoReplay.status).toBe(400);
        expect(rechazoReplay.errorMessage).toBe(
          `Ya existe un corte para la fecha ${FECHA_RECHAZO}.`,
        );
      }

      const counts = await pgUna<{ cortes: number; ops: number }>(
        `select (select count(*)::int from corte where fk_vendedor_id = $1 and fecha in ($2, $3)) cortes,
                (select count(*)::int from sync_operacion where id in ($4, $5)) ops`,
        [vendedorId, FECHA_REPLAY, FECHA_RECHAZO, operationId, operationIdR],
      );
      expect(counts.cortes).toBe(2); // one per fecha, no duplicates from replays
      expect(counts.ops).toBe(2); // aplicada + rechazada, no new rows on replay
    },
    T,
  );

  test(
    "scoping: Agricultor/Cliente 403 en teorico/listar/detalle/crear; Vendedor ajeno no ve el corte; Admin ve todos",
    async () => {
      const idFila = (
        await pgUna<{ id: string }>(
          "select id from corte where fk_vendedor_id = $1 and fecha = $2",
          [vendedorId, FECHA_REPLAY],
        )
      ).id;

      for (const token of [agroToken, clienteToken]) {
        const t = await trpc("query", "cortes.teorico", {}, token);
        expect(t.ok).toBe(false);
        if (!t.ok) expect(t.status).toBe(403);
        const l = await trpc("query", "cortes.listar", {}, token);
        expect(l.ok).toBe(false);
        if (!l.ok) expect(l.status).toBe(403);
        const d = await trpc("query", "cortes.detalle", { id: idFila }, token);
        expect(d.ok).toBe(false);
        if (!d.ok) expect(d.status).toBe(403);
        const c = await crearCorte({ montoReal: "1.00", fecha: FECHA_SCOPING }, token);
        expect(c.ok).toBe(false);
        if (!c.ok) expect(c.status).toBe(403);
      }

      // A foreign seller does not see the corte (list or detail).
      const ajenaLista = await trpc<CorteDto[]>("query", "cortes.listar", {}, vendedor2Token);
      expect(ajenaLista.ok).toBe(true);
      if (ajenaLista.ok) {
        expect(ajenaLista.data.some((c) => c.id === idFila)).toBe(false);
        for (const fila of ajenaLista.data) expect(fila.fkVendedor).not.toBe(vendedorId);
      }
      const ajenaDetalle = await trpc("query", "cortes.detalle", { id: idFila }, vendedor2Token);
      expect(ajenaDetalle.ok).toBe(false);
      if (!ajenaDetalle.ok) expect(ajenaDetalle.status).toBe(403);

      // The owner sees its own rows; the Admin sees them all.
      const propiaLista = await trpc<CorteDto[]>("query", "cortes.listar", {}, vendFixToken);
      expect(propiaLista.ok).toBe(true);
      if (propiaLista.ok) {
        expect(propiaLista.data.some((c) => c.id === idFila)).toBe(true);
        for (const fila of propiaLista.data) expect(fila.fkVendedor).toBe(vendedorId);
      }
      const adminLista = await trpc<CorteDto[]>("query", "cortes.listar", {}, adminToken);
      expect(adminLista.ok).toBe(true);
      if (adminLista.ok) expect(adminLista.data.some((c) => c.id === idFila)).toBe(true);
    },
    T,
  );

  test(
    "outbox M-1a: un fila sync_cambio insert por corte creado (UNA tx)",
    async () => {
      const res = await crearCorte({ montoReal: "0.00", fecha: FECHA_SCOPING });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const outbox = await pgQuery<{ tabla_origen: string; operacion: string }>(
        "select tabla_origen, operacion from sync_cambio where tabla_origen = 'corte' and id_fila = $1",
        [res.data.id],
      );
      expect(outbox.length).toBe(1);
      expect(outbox[0]?.operacion).toBe("insert");
    },
    T,
  );

  test(
    "fechas inválidas y montos inválidos → 400 (zod/aCentavos, nunca negativo ni con 3 decimales)",
    async () => {
      const fechaMala = await crearCorte({ montoReal: "1.00", fecha: "2027-02-30" });
      expect(fechaMala.ok).toBe(false);
      if (!fechaMala.ok) expect(fechaMala.status).toBe(400);

      const montoMalo = await crearCorte({ montoReal: "-1.00", fecha: FECHA_RACE });
      expect(montoMalo.ok).toBe(false);
      if (!montoMalo.ok) expect(montoMalo.status).toBe(400);

      const monto3dec = await crearCorte({ montoReal: "1.000", fecha: FECHA_RACE });
      expect(monto3dec.ok).toBe(false);
      if (!monto3dec.ok) expect(monto3dec.status).toBe(400);
    },
    T,
  );
});
