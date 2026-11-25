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

// P1-C Mermas e2e (docs/roadmap.md §6 P1-C; database.md §3.5 rows + M-6/M-17,
// §4.1 FK policy, §6.2 online-confirm row; backend-audit M1–M3). Rules extracted
// from legacy/rassa_back/rassa/blueprints/waste (views.py + serializers.py +
// tests/test_waste.py) — never copied:
// - Stock flow IS defined in legacy (contrary to the F-27 note): registration
//   decrements producto_semanal.stock in ONE tx with a row lock; stock < cantidad
//   → 400 "Stock insuficiente. Disponible: X, solicitado: Y."; exact stock → 0 OK.
// - cantidad must be > 0 ("La cantidad debe ser mayor a 0."); the DB CHECK
//   merma_cantidad_positiva (M-2 hardening) rejects 0/negative DIRECT writes.
// - The producto_semanal must be a line of the pedido ("El producto semanal no
//   pertenece a este pedido."); the pedido must exist; fk_pedido NOT NULL (M-6).
// - decision_merma is a PLAIN CATALOG in legacy — NO states/transitions exist, so
//   the "invalid transition" proof of the tracker is the extracted decision
//   validation instead: an INACTIVE decision → 400 "La decisión de merma no está
//   activa." (exact legacy message).
// - Scoping: Admin+Vendedor register (legacy HasRole(ADMIN, VENDEDOR)); the
//   vendedor only on HIS pedidos ("El pedido no pertenece al vendedor
//   autenticado."); Agricultor/Cliente are 403; the vendedor only lists mermas of
//   his pedidos; decisions CRUD is Admin-only.
// - operationId replay: the SAME id returns the stored verdict (stock is NOT
//   decremented twice — PG counts unchanged).
// - COL23: online-confirm module (M-17) — no RxDB collection; outbox rows
//   (merma insert + producto_semanal update) ride in ONE tx.

type MermaDto = {
  id: string;
  fkPedido: string;
  cantidad: number;
  motivo: string;
  creadoEn: string;
  estado: boolean;
  productoInfo: { id: string; producto: string; stockRestante: number } | null;
  decisionInfo: { id: string; nombre: string } | null;
  pedidoInfo: {
    id: string;
    folio: string | null;
    cliente: string | null;
    estado: string | null;
    total: string;
  } | null;
};

type DecisionDto = { id: string; decision: string; estado: boolean };

/** SQL fixtures: per-run users with the DEV password (copies of admin's hash). */
async function crearUsuarioFixture(correo: string, nombre: string, rol: string): Promise<string> {
  const localidad = await pgUna<{ id: string }>(
    "select id from localidad where nombre = 'Tepic' and estado order by id limit 1",
  );
  const personaId = crypto.randomUUID();
  await pgQuery(
    `insert into persona (id, nombre, apellido_paterno, fk_localidad)
     values ($1, $2, 'Merma', $3)
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
 * with one known item of a given stock — a fresh farmer per run keeps stock/merma
 * proofs collision-free across runs (re-run safe ×2).
 */
async function crearFarmerConItem(
  correo: string,
  nombre: string,
  productoNombre: string,
  stock: number,
): Promise<{ farmerId: string; itemId: string }> {
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
  const producto = await pgUna<{ id: string }>(
    "select id from producto where nombre = $1 and estado order by id limit 1",
    [productoNombre],
  );
  const itemId = crypto.randomUUID();
  await pgQuery(
    `insert into producto_semanal (id, fk_publicacion, fk_producto, fk_unidad, precio, stock, estado, version)
     values ($1, $2, $3, $4, '10.13', $5, 'activo', 1)`,
    [itemId, pubId, producto.id, unidad.id, stock],
  );
  return { farmerId, itemId };
}

describe("mermas e2e (p1-mermas proofs)", () => {
  let adminToken = "";
  let agroToken = "";
  let clienteToken = "";
  // Per-run vendedor: owns the pedidos the merma proofs register against.
  let vendToken = "";
  let vendAjenoToken = "";
  // Per-run farmer + item: exact-stock proof without touching shared fixtures.
  let itemExactoId = "";
  let idDonar = "";
  let decisionNueva = "";
  let decisionInactiva = "";
  const s = sufijo();

  beforeAll(async () => {
    await ensureServer();
    await ensureFixtures();
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    clienteToken = await tokenDe(CLIENTE, DEV_PASSWORD);

    const correoVend = `e2e-mvend-${s}@fixture.local`;
    await crearUsuarioFixture(correoVend, `VendMerma${s}`, "Vendedor");
    vendToken = await tokenDe(correoVend, DEV_PASSWORD);
    // The base seeded vendedor: its pedidos are foreign to the per-run one.
    vendAjenoToken = await tokenDe(VENDEDOR, DEV_PASSWORD);

    ({ itemId: itemExactoId } = await crearFarmerConItem(
      `e2e-mfarmer-${s}@fixture.local`,
      `FarmerMerma${s}`,
      "Papaya",
      10,
    ));

    const decisiones = (
      (await trpc<DecisionDto[]>("query", "mermas.decisiones.listar", {}, adminToken)) as {
        ok: true;
        data: DecisionDto[];
      }
    ).data;
    idDonar = decisiones.find((d) => d.decision === "Donar")!.id;

    // An active EXTRA decision (created + deactivated in the validation tests below).
    decisionNueva = (
      (await trpc<DecisionDto>(
        "mutation",
        "mermas.decisiones.crear",
        { decision: `Compostar e2e ${s}` },
        adminToken,
      )) as { ok: true; data: DecisionDto }
    ).data.id;
  }, 90_000);

  /** Presencial order owned by the per-run vendedor → the merma target. */
  const crearPedidoDelVendedor = async (
    items: Array<{ fkProductoSemanal: string; cantidad: number }>,
  ): Promise<string> => {
    const pedido = await trpc<{ id: string }>(
      "mutation",
      "pedidos.pedidoPresencial",
      { clienteNombre: `ClienteMerma${sufijo()}`, items },
      vendToken,
    );
    expect(pedido.ok).toBe(true);
    if (!pedido.ok) throw new Error("pedidoPresencial falló");
    return pedido.data.id;
  };

  const registrar = async (entrada: Record<string, unknown>, token = vendToken) =>
    trpc<MermaDto>("mutation", "mermas.registrar", entrada, token);

  test(
    "registrar: descuenta stock en UNA tx (fila + outbox), pedido propio, snapshot pedido/producto; replay operationId idempotente (stock y PG counts sin cambios)",
    async () => {
      const { itemMoneyId } = await ensureFixtures();
      const mermasAntes = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from merma where fk_producto_semanal = $1",
          [itemMoneyId],
        )
      ).n;

      const fkPedido = await crearPedidoDelVendedor([
        { fkProductoSemanal: itemMoneyId, cantidad: 3 },
      ]);
      // The pedido creation itself decrements 3 — the merma delta is ON TOP of it.
      const stockTrasPedido = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          itemMoneyId,
        ])
      ).stock;
      const operationId = crypto.randomUUID();
      const res = await registrar({
        fkPedido,
        fkProductoSemanal: itemMoneyId,
        cantidad: 2,
        motivo: "Producto dañado",
        comentarios: "Se encontró moho",
        fkDecision: idDonar,
        operationId,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.cantidad).toBe(2);
      expect(res.data.fkPedido).toBe(fkPedido);
      expect(res.data.decisionInfo?.nombre).toBe("Donar");
      expect(res.data.pedidoInfo !== null).toBe(true);
      // G1: the pedido info carries the human-readable folio (M-19), not just the UUID.
      expect(res.data.pedidoInfo?.folio).toMatch(/^PED-\d{6}$/);

      // PG: exactly the delta decrement + ONE merma row (M-6 fk_pedido NOT NULL).
      const stockDespues = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          itemMoneyId,
        ])
      ).stock;
      expect(stockDespues).toBe(stockTrasPedido - 2);
      const fila = await pgUna<{ pedido: string; cantidad: number; motivo: string }>(
        "select fk_pedido::text pedido, cantidad, motivo from merma where id = $1",
        [res.data.id],
      );
      expect(fila.pedido).toBe(fkPedido);
      expect(fila.cantidad).toBe(2);

      // Outbox M-1a: merma insert + producto_semanal update (ONE tx, same actor).
      const outbox = await pgQuery<{ tabla_origen: string; operacion: string }>(
        `select tabla_origen, operacion from sync_cambio
         where (tabla_origen = 'merma' and id_fila = $1)
            or (tabla_origen = 'producto_semanal' and id_fila = $2)
         order by tabla_origen`,
        [res.data.id, itemMoneyId],
      );
      expect(
        outbox.filter((o) => o.tabla_origen === "merma" && o.operacion === "insert").length,
      ).toBe(1);
      expect(
        outbox.filter((o) => o.tabla_origen === "producto_semanal" && o.operacion === "update")
          .length,
      ).toBeGreaterThanOrEqual(1);

      // REPLAY with the same operationId → same verdict, NO second decrement.
      const replay = await registrar({
        fkPedido,
        fkProductoSemanal: itemMoneyId,
        cantidad: 2,
        motivo: "Producto dañado",
        fkDecision: idDonar,
        operationId,
      });
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.data.id).toBe(res.data.id);
      const stockReplay = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          itemMoneyId,
        ])
      ).stock;
      expect(stockReplay).toBe(stockTrasPedido - 2);
      const mermasDespues = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from merma where fk_producto_semanal = $1",
          [itemMoneyId],
        )
      ).n;
      expect(mermasDespues).toBe(mermasAntes + 1);
    },
    T,
  );

  test(
    "stock insuficiente → 400 mensaje legacy exacto; replay del rechazo idempotente; stock exacto → 0 válido (legacy test_merma_stock_exacto)",
    async () => {
      // NOTE: the pedido creation itself decrements 1 — read the stock AFTER it so
      // the exact legacy message matches ("Disponible" = post-pedido stock).
      const { itemMoneyId } = await ensureFixtures();
      const fkPedido = await crearPedidoDelVendedor([
        { fkProductoSemanal: itemMoneyId, cantidad: 1 },
      ]);
      const stock = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          itemMoneyId,
        ])
      ).stock;

      const operationId = crypto.randomUUID();
      const insuficiente = await registrar({
        fkPedido,
        fkProductoSemanal: itemMoneyId,
        cantidad: stock + 5,
        motivo: "Demasiado",
        fkDecision: idDonar,
        operationId,
      });
      expect(insuficiente.ok).toBe(false);
      if (!insuficiente.ok) {
        expect(insuficiente.status).toBe(400);
        expect(insuficiente.errorMessage).toBe(
          `Stock insuficiente. Disponible: ${stock}, solicitado: ${stock + 5}.`,
        );
      }
      // Replay of the REJECTED verdict: same message, stored verdict, no effects.
      const replayRechazo = await registrar({
        fkPedido,
        fkProductoSemanal: itemMoneyId,
        cantidad: stock + 5,
        motivo: "Demasiado",
        fkDecision: idDonar,
        operationId,
      });
      expect(replayRechazo.ok).toBe(false);
      if (!replayRechazo.ok) {
        expect(replayRechazo.status).toBe(400);
        expect(replayRechazo.errorMessage).toBe(
          `Stock insuficiente. Disponible: ${stock}, solicitado: ${stock + 5}.`,
        );
      }
      const ops = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_operacion where id = $1 and veredicto = 'rechazada'",
        [operationId],
      );
      expect(ops.n).toBe(1);

      // Exact stock: cantidad == stock → 201 and stock ends at 0 (per-run item).
      // NOTE: the pedido creation itself decrements 1 — read the stock AFTER it.
      const fkPedidoExacto = await crearPedidoDelVendedor([
        { fkProductoSemanal: itemExactoId, cantidad: 1 },
      ]);
      const stockExacto = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          itemExactoId,
        ])
      ).stock;
      const exacta = await registrar({
        fkPedido: fkPedidoExacto,
        fkProductoSemanal: itemExactoId,
        cantidad: stockExacto,
        motivo: "Se malogró todo el lote",
        fkDecision: idDonar,
      });
      expect(exacta.ok).toBe(true);
      const stockFinal = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          itemExactoId,
        ])
      ).stock;
      expect(stockFinal).toBe(0);
    },
    T,
  );

  test(
    "CHECK BD merma_cantidad_positiva: 0 y negativo → 23514; cantidad 0 por API → 400 (mensaje legacy)",
    async () => {
      const { itemMoneyId } = await ensureFixtures();
      const fkPedido = await crearPedidoDelVendedor([
        { fkProductoSemanal: itemMoneyId, cantidad: 1 },
      ]);
      // The M-2 CHECK really is in the catalog.
      const check = await pgUna<{ n: number }>(
        `select count(*)::int n from pg_constraint
         where conname = 'merma_cantidad_positiva' and conrelid = 'merma'::regclass
           and pg_get_constraintdef(oid) like '%cantidad%'`,
      );
      expect(check.n).toBe(1);
      // Direct writes 0 / -1 violate it (M-6 fk_pedido NOT NULL; valid FKs otherwise).
      for (const cantidad of [0, -1]) {
        let codigoError = "";
        try {
          await pgQuery(
            `insert into merma (fk_producto_semanal, fk_pedido, cantidad, motivo, fk_decision)
             values ($1, $2, $3, 'check e2e', $4)`,
            [itemMoneyId, fkPedido, cantidad, idDonar],
          );
        } catch (error) {
          codigoError = (error as { code?: string }).code ?? "";
        }
        expect(codigoError).toBe("23514");
      }
      // API lane: zod rejects <= 0 (v11 serializes the zod issues; the legacy
      // serializer text rides inside the payload — legacy test asserts only 400).
      const cero = await registrar({
        fkPedido,
        fkProductoSemanal: itemMoneyId,
        cantidad: 0,
        motivo: "Nada",
        fkDecision: idDonar,
      });
      expect(cero.ok).toBe(false);
      if (!cero.ok) {
        expect(cero.status).toBe(400);
        expect(cero.errorMessage).toContain("La cantidad debe ser mayor a 0.");
      }
      const negativa = await registrar({
        fkPedido,
        fkProductoSemanal: itemMoneyId,
        cantidad: -1,
        motivo: "Nada",
        fkDecision: idDonar,
      });
      expect(negativa.ok).toBe(false);
      if (!negativa.ok) {
        expect(negativa.status).toBe(400);
        expect(negativa.errorMessage).toContain("La cantidad debe ser mayor a 0.");
      }
    },
    T,
  );

  test(
    "validación: pedido inexistente 400, producto ajeno al pedido 400, decisión inexistente 400, decisión INACTIVA 400 (mensaje legacy exacto)",
    async () => {
      const { itemMoneyId, itemOtroId } = await ensureFixtures();
      const fkPedido = await crearPedidoDelVendedor([
        { fkProductoSemanal: itemMoneyId, cantidad: 1 },
      ]);

      const pedidoMalo = await registrar({
        fkPedido: crypto.randomUUID(),
        fkProductoSemanal: itemMoneyId,
        cantidad: 1,
        motivo: "No existe",
        fkDecision: idDonar,
      });
      expect(pedidoMalo.ok).toBe(false);
      if (!pedidoMalo.ok) {
        expect(pedidoMalo.status).toBe(400);
        expect(pedidoMalo.errorMessage).toBe("El pedido no existe.");
      }

      // itemOtro belongs to farmer2's publication, NOT to this pedido (legacy
      // DetallePedido existence check).
      const ajeno = await registrar({
        fkPedido,
        fkProductoSemanal: itemOtroId,
        cantidad: 1,
        motivo: "Producto ajeno",
        fkDecision: idDonar,
      });
      expect(ajeno.ok).toBe(false);
      if (!ajeno.ok) {
        expect(ajeno.status).toBe(400);
        expect(ajeno.errorMessage).toBe("El producto semanal no pertenece a este pedido.");
      }

      const decisionMala = await registrar({
        fkPedido,
        fkProductoSemanal: itemMoneyId,
        cantidad: 1,
        motivo: "Decisión inexistente",
        fkDecision: crypto.randomUUID(),
      });
      expect(decisionMala.ok).toBe(false);
      if (!decisionMala.ok) {
        expect(decisionMala.status).toBe(400);
        expect(decisionMala.errorMessage).toBe("La decisión de merma no existe.");
      }

      // Deactivate the extra decision → registration with it is rejected with the
      // EXACT legacy message (there are NO transitions in legacy: the decision is a
      // plain catalog, so this IS the decision rule).
      const desactivar = await trpc(
        "mutation",
        "mermas.decisiones.desactivar",
        { id: decisionNueva },
        adminToken,
      );
      expect(desactivar.ok).toBe(true);
      decisionInactiva = decisionNueva;
      const inactiva = await registrar({
        fkPedido,
        fkProductoSemanal: itemMoneyId,
        cantidad: 1,
        motivo: "Decisión inactiva",
        fkDecision: decisionInactiva,
      });
      expect(inactiva.ok).toBe(false);
      if (!inactiva.ok) {
        expect(inactiva.status).toBe(400);
        expect(inactiva.errorMessage).toBe("La decisión de merma no está activa.");
      }
    },
    T,
  );

  test(
    "scoping: Agricultor/Cliente 403 en listar/detalle/registrar/decisiones; Vendedor pedido ajeno → 400 exacto; listado del vendedor NO ve mermas ajenas y el Admin sí",
    async () => {
      const { itemMoneyId } = await ensureFixtures();
      const fkPedido = await crearPedidoDelVendedor([
        { fkProductoSemanal: itemMoneyId, cantidad: 1 },
      ]);
      const creada = await registrar({
        fkPedido,
        fkProductoSemanal: itemMoneyId,
        cantidad: 1,
        motivo: "Scoping",
        fkDecision: idDonar,
      });
      expect(creada.ok).toBe(true);
      if (!creada.ok) return;

      for (const token of [agroToken, clienteToken]) {
        const l = await trpc("query", "mermas.listar", {}, token);
        expect(l.ok).toBe(false);
        if (!l.ok) expect(l.status).toBe(403);
        const d = await trpc("query", "mermas.detalle", { id: creada.data.id }, token);
        expect(d.ok).toBe(false);
        if (!d.ok) expect(d.status).toBe(403);
        const r = await registrar(
          {
            fkPedido,
            fkProductoSemanal: itemMoneyId,
            cantidad: 1,
            motivo: "No autorizado",
            fkDecision: idDonar,
          },
          token,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(403);
        const cd = await trpc(
          "mutation",
          "mermas.decisiones.crear",
          { decision: `Ajena ${s}` },
          token,
        );
        expect(cd.ok).toBe(false);
        if (!cd.ok) expect(cd.status).toBe(403);
      }

      // The BASE vendedor's pedidos are foreign to the per-run vendedor: exact 400.
      const ajena = await registrar(
        {
          fkPedido,
          fkProductoSemanal: itemMoneyId,
          cantidad: 1,
          motivo: "Pedido ajeno",
          fkDecision: idDonar,
        },
        vendAjenoToken,
      );
      expect(ajena.ok).toBe(false);
      if (!ajena.ok) {
        expect(ajena.status).toBe(400);
        expect(ajena.errorMessage).toBe("El pedido no pertenece al vendedor autenticado.");
      }

      // List scoping: the base vendedor must NOT see the per-run vendedor's merma;
      // the Admin must.
      const listaAjena = (
        (await trpc<MermaDto[]>("query", "mermas.listar", {}, vendAjenoToken)) as {
          ok: true;
          data: MermaDto[];
        }
      ).data;
      expect(listaAjena.some((m) => m.id === creada.data.id)).toBe(false);
      const listaAdmin = (
        (await trpc<MermaDto[]>("query", "mermas.listar", {}, adminToken)) as {
          ok: true;
          data: MermaDto[];
        }
      ).data;
      expect(listaAdmin.some((m) => m.id === creada.data.id)).toBe(true);

      // Retrieve scoping: a foreign merma is simply NOT FOUND for the vendedor
      // (legacy queryset parity); the Admin retrieves it.
      const detalleAjeno = await trpc(
        "query",
        "mermas.detalle",
        { id: creada.data.id },
        vendAjenoToken,
      );
      expect(detalleAjeno.ok).toBe(false);
      if (!detalleAjeno.ok) expect(detalleAjeno.status).toBe(404);
      const detalleAdmin = await trpc<MermaDto>(
        "query",
        "mermas.detalle",
        { id: creada.data.id },
        adminToken,
      );
      expect(detalleAdmin.ok).toBe(true);
    },
    T,
  );

  test(
    "catálogo decisiones: Vendedor NO crea (403) pero SÍ consulta (formulario); Admin duplicado → 400; incluirInactivos solo Admin",
    async () => {
      const vendedorCrea = await trpc(
        "mutation",
        "mermas.decisiones.crear",
        { decision: `Vend ${s}` },
        vendToken,
      );
      expect(vendedorCrea.ok).toBe(false);
      if (!vendedorCrea.ok) expect(vendedorCrea.status).toBe(403);

      // The inactive decision is hidden from the DEFAULT list (both roles), visible
      // to the Admin with incluirInactivos (audit parity).
      const listaVend = (
        (await trpc<DecisionDto[]>("query", "mermas.decisiones.listar", {}, vendToken)) as {
          ok: true;
          data: DecisionDto[];
        }
      ).data;
      expect(listaVend.some((d) => d.id === decisionInactiva)).toBe(false);

      const duplicada = await trpc(
        "mutation",
        "mermas.decisiones.crear",
        { decision: `Compostar e2e ${s}` },
        adminToken,
      );
      expect(duplicada.ok).toBe(false);
      if (!duplicada.ok) {
        expect(duplicada.status).toBe(400);
        expect(duplicada.errorMessage).toBe(`La decisión "Compostar e2e ${s}" ya existe.`);
      }

      const listaAdminInactivos = (
        (await trpc<DecisionDto[]>(
          "query",
          "mermas.decisiones.listar",
          { incluirInactivos: true },
          adminToken,
        )) as { ok: true; data: DecisionDto[] }
      ).data;
      expect(listaAdminInactivos.some((d) => d.id === decisionInactiva)).toBe(true);
    },
    T,
  );

  test(
    "#19 pedido fk_vendedor NULL (SQL fixture de ids fijos, patrón C1): vendedor → 400 mensaje legacy exacto; Admin → permitido (paridad test_merma_pedido_sin_vendedor_rechazado / test_admin_puede_usar_pedido_sin_vendedor)",
    async () => {
      // Fixed-id upsert fixture (re-run convergente): v2 never creates
      // fk_vendedor NULL — digital orders keep fk_cliente, presenciales
      // auto-assign the seller. The folio 'PED-000000' text-sorts BELOW every
      // real 'PED-000001…' folio (all-zero suffix — true even on a FRESH
      // per-run DB where real max may be 'PED-0000xx': digits < digits never
      // happens, but '0' < any nonzero digit does, and every real folio has a
      // nonzero digit somewhere), so the M-19 folio e2e's max(folio) and the
      // seed's numeric max never see it; the seed's folio scan only counts
      // ^PED-[0-9]+$. Nothing to restore (the row dies with the module's
      // residual per-run data pattern).
      const ids19 = {
        persona: "e2e19a00-0000-4000-8000-0000000001f2",
        farmer: "e2e19a00-0000-4000-8000-0000000001f1",
        pub: "e2e19a00-0000-4000-8000-0000000001f3",
        item: "e2e19a00-0000-4000-8000-0000000001f4",
        pedido: "e2e19a00-0000-4000-8000-0000000001f5",
        detalle: "e2e19a00-0000-4000-8000-0000000001f6",
      } as const;
      const localidad = await pgUna<{ id: string }>(
        "select id from localidad where nombre = 'Tepic' and estado order by id limit 1",
      );
      await pgQuery(
        `insert into persona (id, nombre, apellido_paterno, fk_localidad)
         values ($1, 'FarmerM19', 'Fixture', $2)
         on conflict (id) do nothing`,
        [ids19.persona, localidad.id],
      );
      await pgQuery(
        `insert into usuario (id, correo, password_hash, fk_persona, fk_rol, estado)
         select $1, 'e2e-merma19-novend@fixture.local', u.password_hash, $2, r.id, true
         from usuario u, roles r
         where u.correo = $3 and r.nombre = 'Agricultor'
         on conflict (correo) do nothing`,
        [ids19.farmer, ids19.persona, ADMIN],
      );
      const lunes = aFechaCiclo(mondayOfBusinessWeek(new Date()));
      const { semanaIso, anioIso } = isoWeekFromMonday(new Date(`${lunes}T00:00:00.000Z`));
      const producto = await pgUna<{ id: string }>(
        "select id from producto where nombre = 'Papaya' and estado order by id limit 1",
      );
      const unidad = await pgUna<{ id: string }>(
        "select id from unidad where abreviatura = 'kg' limit 1",
      );
      await pgQuery(
        `insert into publicacion_semanal (id, fk_agricultor, fecha_ciclo, semana_iso, anio_iso, estado, version)
         values ($1, $2, $3::date, $4, $5, 'publicado', 1)
         on conflict (id) do update set fecha_ciclo = excluded.fecha_ciclo,
           semana_iso = excluded.semana_iso, anio_iso = excluded.anio_iso, estado = 'publicado'`,
        [ids19.pub, ids19.farmer, lunes, semanaIso, anioIso],
      );
      await pgQuery(
        `insert into producto_semanal (id, fk_publicacion, fk_producto, fk_unidad, precio, stock, estado, version)
         values ($1, $2, $3, $4, '10.13', 1000, 'activo', 1)
         on conflict (id) do update set fk_publicacion = excluded.fk_publicacion,
           fk_producto = excluded.fk_producto, precio = excluded.precio, estado = 'activo'`,
        [ids19.item, ids19.pub, producto.id, unidad.id],
      );
      const idPendiente = await pgUna<{ id: string }>(
        "select id from estado_pedido where nombre = 'pendiente'",
      );
      await pgQuery(
        `insert into pedido_cabecera (id, folio, fk_estado, subtotal, iva, total, origen, version)
         values ($1, 'PED-000000', $2, 0, 0, 0, 'presencial', 1)
         on conflict (id) do update set folio = excluded.folio`,
        [ids19.pedido, idPendiente.id],
      );
      await pgQuery(
        `insert into detalle_pedido (id, fk_pedido, fk_producto_semanal, nombre_producto, cantidad, precio_unitario, importe)
         values ($1, $2, $3, 'Papaya', 1, 10.13, 10.13)
         on conflict (id) do nothing`,
        [ids19.detalle, ids19.pedido, ids19.item],
      );

      // Vendedor on a vendedor-less order → the EXACT legacy rejection, decided
      // BEFORE the stock flow (no decrement happens).
      const stockAntesRechazo = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          ids19.item,
        ])
      ).stock;
      const rechazo = await registrar({
        fkPedido: ids19.pedido,
        fkProductoSemanal: ids19.item,
        cantidad: 1,
        motivo: "Rechazo pedido sin vendedor",
        fkDecision: idDonar,
      });
      expect(rechazo.ok).toBe(false);
      if (!rechazo.ok) {
        expect(rechazo.status).toBe(400);
        expect(rechazo.errorMessage).toBe("El pedido no pertenece al vendedor autenticado.");
      }
      const stockDespuesRechazo = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          ids19.item,
        ])
      ).stock;
      expect(stockDespuesRechazo).toBe(stockAntesRechazo);

      // Admin bypasses the ownership rule and the merma lands (stock −1, +1 merma
      // per run — asserted as deltas so re-runs converge).
      const stockAntes = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          ids19.item,
        ])
      ).stock;
      const mermasAntes = (
        await pgUna<{ n: number }>("select count(*)::int n from merma where fk_pedido = $1", [
          ids19.pedido,
        ])
      ).n;
      const admin = await registrar(
        {
          fkPedido: ids19.pedido,
          fkProductoSemanal: ids19.item,
          cantidad: 1,
          motivo: "Bypass Admin pedido sin vendedor",
          fkDecision: idDonar,
          operationId: crypto.randomUUID(),
        },
        adminToken,
      );
      expect(admin.ok).toBe(true);
      if (!admin.ok) return;
      expect(admin.data.fkPedido).toBe(ids19.pedido);
      const stockDespues = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          ids19.item,
        ])
      ).stock;
      expect(stockDespues).toBe(stockAntes - 1);
      const mermasDespues = (
        await pgUna<{ n: number }>("select count(*)::int n from merma where fk_pedido = $1", [
          ids19.pedido,
        ])
      ).n;
      expect(mermasDespues).toBe(mermasAntes + 1);
    },
    T,
  );
});
