import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN,
  DEV_PASSWORD,
  VENDEDOR,
  VENDEDOR2,
  ensureFixtures,
  ensureServer,
  login,
  must,
  pgQuery,
  pgUna,
  sufijo,
  tokenDe,
  trpc,
  type Fixture,
} from "./helpers";

const T = 240_000;

type TipoPagoDto = {
  id: string;
  nombre: string;
};

type DetalleDto = {
  id: string;
  fkProductoSemanal: string;
  nombreProducto: string;
  cantidad: number;
  precioUnitario: string;
  importe: string;
  version: number;
};

type PedidoDto = {
  id: string;
  folio: string;
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
};

type RegistrarPagoDto = {
  pagoId: string;
  folioPago: string;
  reciboId: string;
  folioRecibo: string;
  monto: string;
  estado: string;
};

type ReciboDetalleDto = {
  recibo: {
    id: string;
    folio: string;
    emitidoEn: string;
    datos: {
      pedidoId: string;
      total: string;
      subtotal: string;
      iva: string;
      items: Array<{ nombre: string; cantidad: number; precioUnitario: string; importe: string }>;
      cliente: { id: string | null; correo: string | null; nombre: string | null };
      tipoPago: string;
      folioPago: string;
    };
  };
  pago: {
    id: string;
    folio: string;
    monto: string;
    tipoPago: { nombre: string };
  };
};

type RegistroOk = { ok: true; correo: string };

async function localidadActivaId(): Promise<string> {
  return (await pgUna<{ id: string }>("select id from localidad where estado order by id limit 1"))
    .id;
}

async function registrarClienteConLimite(
  adminToken: string,
  montoLimite: number,
): Promise<{ id: string; email: string; token: string }> {
  const locId = await localidadActivaId();
  const s = sufijo();
  const email = `cliente-pago-${s}@test.local`;
  await must<RegistroOk>("mutation", "usuarios.register", {
    email,
    password: DEV_PASSWORD,
    nombre: "ClientePago",
    apellidoPaterno: `Suf${s}`,
    fkLocalidad: locId,
  });
  const ses = await login(email, DEV_PASSWORD);
  await must(
    "mutation",
    "familias.create",
    {
      nombre: `FamPago-${s}`,
      jefeEmail: email,
      montoLimite,
    },
    adminToken,
  );
  return { id: ses.user.id, email, token: ses.token };
}

describe("pagos e2e (p0-pagos proofs)", () => {
  let adminToken = "";
  let vendedorToken = "";
  let vendedor2Token = "";
  let fx: Fixture;

  beforeAll(async () => {
    await ensureServer();
    fx = await ensureFixtures();
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
    vendedorToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    vendedor2Token = await tokenDe(VENDEDOR2, DEV_PASSWORD);
  }, 90_000);

  test(
    "tiposPago lista los 3 valores sembrados (Efectivo, Transferencia, Depósito)",
    async () => {
      const res = await trpc<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const nombres = res.data.map((t) => t.nombre);
      expect(nombres).toContain("Efectivo");
      expect(nombres).toContain("Transferencia");
      expect(nombres).toContain("Depósito");
    },
    T,
  );

  test(
    "registrarPago deriva monto == pedido.total del servidor, genera folio monotónico R-..., crea recibo 1:1 y avanza pedido a confirmado en una tx con outbox",
    async () => {
      const cliente = await registrarClienteConLimite(adminToken, 1000);
      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 2 }] },
        cliente.token,
      );
      // Claim by seller
      await must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: pedido.id }, vendedorToken);

      const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
      const efectivo = tipos.find((t) => t.nombre === "Efectivo")!;

      const seqAntes = (
        await pgUna<{ siguiente: number }>(
          "select siguiente from folio_secuencia where nombre = 'pago'",
        )
      ).siguiente;

      const pagoRes = await trpc<RegistrarPagoDto>(
        "mutation",
        "pagos.registrarPago",
        {
          fkPedido: pedido.id,
          fkTipoPago: efectivo.id,
          referencia: "REF-TEST-001",
        },
        vendedorToken,
      );

      expect(pagoRes.ok).toBe(true);
      if (!pagoRes.ok) return;

      expect(pagoRes.data.monto).toBe(pedido.total);
      expect(pagoRes.data.folioPago).toMatch(/^R-\d{6}$/);
      expect(pagoRes.data.folioRecibo).toMatch(/^REC-\d{6}$/);
      expect(pagoRes.data.estado).toBe("confirmado");

      // Verify DB row
      const dbPago = await pgUna<{ monto: string; folio: string }>(
        "select monto, folio from pago where fk_pedido = $1",
        [pedido.id],
      );
      expect(Number(dbPago.monto).toFixed(2)).toBe(pedido.total);

      // Verify sequence incremented
      const seqDespues = (
        await pgUna<{ siguiente: number }>(
          "select siguiente from folio_secuencia where nombre = 'pago'",
        )
      ).siguiente;
      expect(seqDespues).toBe(seqAntes + 1);

      // Verify outbox entries in sync_cambio
      const outbox = await pgQuery<{ tabla_origen: string; operacion: string }>(
        "select tabla_origen, operacion from sync_cambio where (tabla_origen = 'pago' and id_fila = $1) or (tabla_origen = 'recibo' and id_fila = $2) or (tabla_origen = 'pedido_cabecera' and id_fila = $3)",
        [pagoRes.data.pagoId, pagoRes.data.reciboId, pedido.id],
      );
      expect(outbox.some((o) => o.tabla_origen === "pago" && o.operacion === "insert")).toBe(true);
      expect(outbox.some((o) => o.tabla_origen === "recibo" && o.operacion === "insert")).toBe(
        true,
      );
      expect(
        outbox.some((o) => o.tabla_origen === "pedido_cabecera" && o.operacion === "update"),
      ).toBe(true);
    },
    T,
  );

  test(
    "duplicate registrarPago -> 409 con PG counts sin cambios (UNIQUE fk_pedido)",
    async () => {
      const cliente = await registrarClienteConLimite(adminToken, 1000);
      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        cliente.token,
      );
      await must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: pedido.id }, vendedorToken);
      const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
      const tipoId = tipos[0]!.id;

      await must<RegistrarPagoDto>(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: pedido.id, fkTipoPago: tipoId },
        vendedorToken,
      );

      const countAntes = (await pgUna<{ n: number }>("select count(*)::int as n from pago")).n;

      // Duplicate payment attempt
      const dup = await trpc(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: pedido.id, fkTipoPago: tipoId },
        vendedorToken,
      );
      expect(dup.ok).toBe(false);
      if (dup.ok) return;
      expect(dup.status).toBe(409);

      const countDespues = (await pgUna<{ n: number }>("select count(*)::int as n from pago")).n;
      expect(countDespues).toBe(countAntes);
    },
    T,
  );

  test(
    "folios monotónicos bajo pagos paralelos (Promise.all de 3 pagos -> 3 folios distintos y secuenciales)",
    async () => {
      const cliente = await registrarClienteConLimite(adminToken, 2000);
      const [p1, p2, p3] = await Promise.all([
        must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
          cliente.token,
        ),
        must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
          cliente.token,
        ),
        must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
          cliente.token,
        ),
      ]);

      await Promise.all([
        must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: p1.id }, vendedorToken),
        must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: p2.id }, vendedorToken),
        must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: p3.id }, vendedorToken),
      ]);

      const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
      const tipoId = tipos[0]!.id;

      const resultados = await Promise.all([
        must<RegistrarPagoDto>(
          "mutation",
          "pagos.registrarPago",
          { fkPedido: p1.id, fkTipoPago: tipoId },
          vendedorToken,
        ),
        must<RegistrarPagoDto>(
          "mutation",
          "pagos.registrarPago",
          { fkPedido: p2.id, fkTipoPago: tipoId },
          vendedorToken,
        ),
        must<RegistrarPagoDto>(
          "mutation",
          "pagos.registrarPago",
          { fkPedido: p3.id, fkTipoPago: tipoId },
          vendedorToken,
        ),
      ]);

      const foliosPago = resultados.map((r) => r.folioPago);
      const foliosRecibo = resultados.map((r) => r.folioRecibo);

      // All distinct
      expect(new Set(foliosPago).size).toBe(3);
      expect(new Set(foliosRecibo).size).toBe(3);

      // Monotonic sequence numbers
      const numsPago = foliosPago
        .map((f) => parseInt(f.replace("R-", ""), 10))
        .sort((a, b) => a - b);
      expect(numsPago[1]).toBe(numsPago[0]! + 1);
      expect(numsPago[2]).toBe(numsPago[1]! + 1);
    },
    T,
  );

  test(
    "marcarEntregado con CAS version avanza pedido confirmado a entregado; replay devuelve error",
    async () => {
      const cliente = await registrarClienteConLimite(adminToken, 1000);
      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        cliente.token,
      );
      await must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: pedido.id }, vendedorToken);
      const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
      await must<RegistrarPagoDto>(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: pedido.id, fkTipoPago: tipos[0]!.id },
        vendedorToken,
      );

      const entregado = await must<{ success: boolean; pedidoId: string; estado: string }>(
        "mutation",
        "pagos.marcarEntregado",
        { fkPedido: pedido.id },
        vendedorToken,
      );
      expect(entregado.estado).toBe("entregado");

      // Verify historial contains entregado
      const hist = await pgQuery<{ estado: string }>(
        `select e.nombre as estado from historial_estado_pedido h
         join estado_pedido e on e.id = h.fk_estado
         where h.fk_pedido = $1 order by h.fecha desc limit 1`,
        [pedido.id],
      );
      expect(hist[0]?.estado).toBe("entregado");

      // Replay attempt throws BAD_REQUEST because it's already entregado
      const replay = await trpc(
        "mutation",
        "pagos.marcarEntregado",
        { fkPedido: pedido.id },
        vendedorToken,
      );
      expect(replay.ok).toBe(false);
    },
    T,
  );

  test(
    "scoping de pagos: cliente ajeno 403, vendedor de otro pedido 403, cliente dueño puede ver su recibo",
    async () => {
      const c1 = await registrarClienteConLimite(adminToken, 1000);
      const c2 = await registrarClienteConLimite(adminToken, 1000);
      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        c1.token,
      );
      await must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: pedido.id }, vendedorToken);
      const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);

      // Vendedor 2 tries to pay order assigned to Vendedor 1 -> 403
      const otroVend = await trpc(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: pedido.id, fkTipoPago: tipos[0]!.id },
        vendedor2Token,
      );
      expect(otroVend.ok).toBe(false);
      if (!otroVend.ok) {
        expect(otroVend.status).toBe(403);
      }

      // Cliente tries to pay directly -> 403 (only sellers/admin)
      const cliPago = await trpc(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: pedido.id, fkTipoPago: tipos[0]!.id },
        c1.token,
      );
      expect(cliPago.ok).toBe(false);
      if (!cliPago.ok) {
        expect(cliPago.status).toBe(403);
      }

      // Vendedor 1 pays legitimately
      await must<RegistrarPagoDto>(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: pedido.id, fkTipoPago: tipos[0]!.id },
        vendedorToken,
      );

      // Cliente 1 (owner) reads receipt -> OK
      const reciboOwner = await trpc<ReciboDetalleDto>(
        "query",
        "pagos.obtenerRecibo",
        { fkPedido: pedido.id },
        c1.token,
      );
      expect(reciboOwner.ok).toBe(true);

      // Cliente 2 (unrelated) tries to read receipt -> 403
      const reciboAjeno = await trpc(
        "query",
        "pagos.obtenerRecibo",
        { fkPedido: pedido.id },
        c2.token,
      );
      expect(reciboAjeno.ok).toBe(false);
      if (!reciboAjeno.ok) {
        expect(reciboAjeno.status).toBe(403);
      }
    },
    T,
  );

  test(
    "liberación de crédito Q-10: pedido a crédito sobre el límite viejo cabe tras pagar el pedido previo",
    async () => {
      // Limit 100 MXN. Order 1 is total 70.50 MXN (subtotal 60.78 + iva 9.72).
      // Placing another order of 70.50 fails (70.50 + 70.50 = 141 > 100).
      // After paying Order 1, Order 1 is 'confirmado' (not 'pendiente') -> credit freed -> Order 2 succeeds!
      const cliente = await registrarClienteConLimite(adminToken, 100);

      const p1 = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        {
          items: [
            { fkProductoSemanal: fx.itemMoneyId, cantidad: 1 },
            { fkProductoSemanal: fx.itemMoney2Id, cantidad: 2 },
            { fkProductoSemanal: fx.itemMoney3Id, cantidad: 3 },
          ],
        },
        cliente.token,
      );
      expect(Number(p1.total)).toBe(70.5);

      // Second identical order must fail because credit limit (100) is exceeded (70.5 + 70.5 = 141)
      const intentoExceso = await trpc(
        "mutation",
        "pedidos.checkout",
        {
          items: [
            { fkProductoSemanal: fx.itemMoneyId, cantidad: 1 },
            { fkProductoSemanal: fx.itemMoney2Id, cantidad: 2 },
            { fkProductoSemanal: fx.itemMoney3Id, cantidad: 3 },
          ],
        },
        cliente.token,
      );
      expect(intentoExceso.ok).toBe(false);
      if (!intentoExceso.ok) {
        expect(intentoExceso.errorMessage).toContain("Límite de crédito insuficiente");
      }

      // Claim and pay Order 1
      await must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: p1.id }, vendedorToken);
      const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
      await must<RegistrarPagoDto>(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: p1.id, fkTipoPago: tipos[0]!.id },
        vendedorToken,
      );

      // Now Order 2 MUST succeed because Order 1 is paid and only 'pendiente' orders consume credit!
      const p2 = await trpc<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        {
          items: [
            { fkProductoSemanal: fx.itemMoneyId, cantidad: 1 },
            { fkProductoSemanal: fx.itemMoney2Id, cantidad: 2 },
            { fkProductoSemanal: fx.itemMoney3Id, cantidad: 3 },
          ],
        },
        cliente.token,
      );
      expect(p2.ok).toBe(true);
      if (p2.ok) {
        expect(Number(p2.data.total)).toBe(70.5);
      }
    },
    T,
  );

  test(
    "CHECK monto > 0 a nivel base de datos: rechaza monto <= 0 en tabla pago",
    async () => {
      const cliente = await registrarClienteConLimite(adminToken, 1000);
      const p = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        cliente.token,
      );
      await must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: p.id }, vendedorToken);
      const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
      const pago = await must<RegistrarPagoDto>(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: p.id, fkTipoPago: tipos[0]!.id },
        vendedorToken,
      );

      // Attempt direct SQL update with monto = -5.00 -> MUST fail with PG check violation
      let errorThrown = false;
      try {
        await pgQuery("update pago set monto = -5.00 where id = $1", [pago.pagoId]);
      } catch (err: unknown) {
        errorThrown = true;
        expect(String(err)).toContain("pago_monto_positivo");
      }
      expect(errorThrown).toBe(true);
    },
    T,
  );

  // =========================================================================
  // Bloque normativo de decisión: Cancelación de pedidos con pago registrado
  // =========================================================================
  describe("Regla de negocio: Bloqueo de cancelación para pedidos con pago registrado", () => {
    test(
      "1. Cancelar pedido sin pago en estado pendiente: PERMITIDO y restaura stock",
      async () => {
        const cliente = await registrarClienteConLimite(adminToken, 1000);
        const stockAntes = (
          await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
            fx.itemStockId,
          ])
        ).stock;

        const pedido = await must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemStockId, cantidad: 2 }] },
          cliente.token,
        );

        const stockDurante = (
          await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
            fx.itemStockId,
          ])
        ).stock;
        expect(stockDurante).toBe(stockAntes - 2);

        // Cancel order without payment
        const cancelado = await must<PedidoDto>(
          "mutation",
          "pedidos.cancelar",
          { pedidoId: pedido.id, version: pedido.version },
          cliente.token,
        );
        expect(cancelado.estadoNombre).toBe("cancelado");

        const stockDespues = (
          await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
            fx.itemStockId,
          ])
        ).stock;
        expect(stockDespues).toBe(stockAntes);
      },
      T,
    );

    test(
      "2. Cancelar pedido pagado en confirmado: RECHAZADO con 409 y mensaje exacto",
      async () => {
        const cliente = await registrarClienteConLimite(adminToken, 1000);
        const pedido = await must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
          cliente.token,
        );
        await must<PedidoDto>(
          "mutation",
          "pedidos.claimar",
          { pedidoId: pedido.id },
          vendedorToken,
        );
        const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
        await must<RegistrarPagoDto>(
          "mutation",
          "pagos.registrarPago",
          { fkPedido: pedido.id, fkTipoPago: tipos[0]!.id },
          vendedorToken,
        );

        // Fetch latest version
        const pConf = await pgUna<{ version: number }>(
          "select version from pedido_cabecera where id = $1",
          [pedido.id],
        );

        // Attempt cancel by seller -> 409
        const resCancel = await trpc(
          "mutation",
          "pedidos.cancelar",
          { pedidoId: pedido.id, version: pConf.version },
          vendedorToken,
        );
        expect(resCancel.ok).toBe(false);
        if (!resCancel.ok) {
          expect(resCancel.status).toBe(409);
          expect(resCancel.errorMessage).toBe(
            "No se puede cancelar un pedido con pago registrado. Contacta con el administrador para gestionar una posible devolución mediante el procedimiento correspondiente.",
          );
        }
      },
      T,
    );

    test(
      "3. Cancelar pedido pagado entregado (flujo pendiente→confirmado→entregado): RECHAZADO con 409",
      async () => {
        const cliente = await registrarClienteConLimite(adminToken, 1000);
        const pedido = await must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
          cliente.token,
        );
        await must<PedidoDto>(
          "mutation",
          "pedidos.claimar",
          { pedidoId: pedido.id },
          vendedorToken,
        );
        const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
        await must<RegistrarPagoDto>(
          "mutation",
          "pagos.registrarPago",
          { fkPedido: pedido.id, fkTipoPago: tipos[0]!.id },
          vendedorToken,
        );

        // Real 4-state flow: the paid 'confirmado' order advances to 'entregado'
        // through the real mutation (no SQL state surgery — the legacy
        // intermediate states no longer exist in the catalog).
        await must<{ success: boolean; pedidoId: string; estado: string }>(
          "mutation",
          "pagos.marcarEntregado",
          { fkPedido: pedido.id },
          vendedorToken,
        );
        const pEntregado = await pgUna<{ version: number }>(
          "select version from pedido_cabecera where id = $1",
          [pedido.id],
        );

        const res = await trpc(
          "mutation",
          "pedidos.cancelar",
          { pedidoId: pedido.id, version: pEntregado.version },
          vendedorToken,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.status).toBe(409);
          expect(res.errorMessage).toBe(
            "No se puede cancelar un pedido con pago registrado. Contacta con el administrador para gestionar una posible devolución mediante el procedimiento correspondiente.",
          );
        }
      },
      T,
    );

    test(
      "4. Marcar entregado solo desde confirmado: RECHAZADO desde pendiente con BAD_REQUEST",
      async () => {
        const cliente = await registrarClienteConLimite(adminToken, 1000);
        const pedido = await must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
          cliente.token,
        );
        await must<PedidoDto>(
          "mutation",
          "pedidos.claimar",
          { pedidoId: pedido.id },
          vendedorToken,
        );

        // Claimed but NOT paid: still 'pendiente' in the 4-state flow, so the
        // delivery transition must be rejected (only 'confirmado' can be
        // delivered — payment is what advances pendiente→confirmado).
        const res = await trpc(
          "mutation",
          "pagos.marcarEntregado",
          { fkPedido: pedido.id },
          vendedorToken,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.status).toBe(400);
          expect(res.errorMessage).toBe(
            "Solo se puede marcar como entregado un pedido en estado confirmado",
          );
        }
      },
      T,
    );

    test(
      "5. Intentar cancelar desde Admin un pedido pagado: RECHAZADO (Admin no puede omitir la protección)",
      async () => {
        const cliente = await registrarClienteConLimite(adminToken, 1000);
        const pedido = await must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
          cliente.token,
        );
        await must<PedidoDto>(
          "mutation",
          "pedidos.claimar",
          { pedidoId: pedido.id },
          vendedorToken,
        );
        const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
        await must<RegistrarPagoDto>(
          "mutation",
          "pagos.registrarPago",
          { fkPedido: pedido.id, fkTipoPago: tipos[0]!.id },
          vendedorToken,
        );

        const pConf = await pgUna<{ version: number }>(
          "select version from pedido_cabecera where id = $1",
          [pedido.id],
        );

        const resAdmin = await trpc(
          "mutation",
          "pedidos.cancelar",
          { pedidoId: pedido.id, version: pConf.version },
          adminToken,
        );
        expect(resAdmin.ok).toBe(false);
        if (!resAdmin.ok) {
          expect(resAdmin.status).toBe(409);
          expect(resAdmin.errorMessage).toBe(
            "No se puede cancelar un pedido con pago registrado. Contacta con el administrador para gestionar una posible devolución mediante el procedimiento correspondiente.",
          );
        }
      },
      T,
    );

    test(
      "6, 7, 8. Verificación de invariantes: stock no restaurado, pago y recibo intactos, sin transición en historial",
      async () => {
        const cliente = await registrarClienteConLimite(adminToken, 1000);
        const stockInicial = (
          await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
            fx.itemStockId,
          ])
        ).stock;

        const pedido = await must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemStockId, cantidad: 2 }] },
          cliente.token,
        );
        expect(
          (
            await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
              fx.itemStockId,
            ])
          ).stock,
        ).toBe(stockInicial - 2);

        await must<PedidoDto>(
          "mutation",
          "pedidos.claimar",
          { pedidoId: pedido.id },
          vendedorToken,
        );
        const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
        const pagoRes = await must<RegistrarPagoDto>(
          "mutation",
          "pagos.registrarPago",
          { fkPedido: pedido.id, fkTipoPago: tipos[0]!.id },
          vendedorToken,
        );

        const cantHistorialAntes = (
          await pgUna<{ n: number }>(
            "select count(*)::int as n from historial_estado_pedido where fk_pedido = $1",
            [pedido.id],
          )
        ).n;

        const pConf = await pgUna<{ version: number }>(
          "select version from pedido_cabecera where id = $1",
          [pedido.id],
        );

        // Try cancel -> rejected
        await trpc(
          "mutation",
          "pedidos.cancelar",
          { pedidoId: pedido.id, version: pConf.version },
          adminToken,
        );

        // 6. Stock NOT restored
        const stockFinal = (
          await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
            fx.itemStockId,
          ])
        ).stock;
        expect(stockFinal).toBe(stockInicial - 2);

        // 7. Pago & Recibo intact
        const pagoDb = await pgUna<{ id: string; monto: string }>(
          "select id, monto from pago where fk_pedido = $1",
          [pedido.id],
        );
        expect(pagoDb.id).toBe(pagoRes.pagoId);
        const reciboDb = await pgUna<{ id: string }>("select id from recibo where fk_pago = $1", [
          pagoDb.id,
        ]);
        expect(reciboDb.id).toBe(pagoRes.reciboId);

        // 8. No cancel transition in historial
        const cantHistorialDespues = (
          await pgUna<{ n: number }>(
            "select count(*)::int as n from historial_estado_pedido where fk_pedido = $1",
            [pedido.id],
          )
        ).n;
        expect(cantHistorialDespues).toBe(cantHistorialAntes);
      },
      T,
    );

    test(
      "9. Concurrencia entre pago y cancelación: serialización atómica (nunca ambos tienen éxito)",
      async () => {
        const cliente = await registrarClienteConLimite(adminToken, 1000);
        const pedido = await must<PedidoDto>(
          "mutation",
          "pedidos.checkout",
          { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
          cliente.token,
        );
        await must<PedidoDto>(
          "mutation",
          "pedidos.claimar",
          { pedidoId: pedido.id },
          vendedorToken,
        );
        const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);

        // Fire both registrarPago and cancelar concurrently
        const [resPago, resCancel] = await Promise.all([
          trpc<RegistrarPagoDto>(
            "mutation",
            "pagos.registrarPago",
            { fkPedido: pedido.id, fkTipoPago: tipos[0]!.id },
            vendedorToken,
          ),
          trpc<PedidoDto>(
            "mutation",
            "pedidos.cancelar",
            { pedidoId: pedido.id, version: pedido.version },
            vendedorToken,
          ),
        ]);

        // Exactly one MUST succeed, the other MUST fail
        const exitos = [resPago.ok, resCancel.ok].filter(Boolean).length;
        expect(exitos).toBe(1);

        if (resPago.ok) {
          // If payment won, cancellation must have failed with 409
          expect(resCancel.ok).toBe(false);
          if (!resCancel.ok) {
            expect(resCancel.status).toBe(409);
          }
        } else {
          // If cancellation won, payment must have failed (not in pendiente anymore)
          expect(resPago.ok).toBe(false);
        }
      },
      T,
    );
  });

  // Q-28 (gap-pass-9): WS pedido notifications. The chat suite owns the canonical
  // WS harness (chat.test.ts abrirSocket/esperarEvento) — kept local there, so the
  // two tiny helpers are mirrored here bound to the pedido event shape.
  type EventoPedido = {
    tipo: string;
    pedidoId: string;
    folio: string;
    estadoNuevo: string;
    mensaje: string;
  };

  function abrirSocket(url: string, deadlineMs = 10_000): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(
        () => reject(new Error(`[WS OPEN TIMEOUT ${deadlineMs}ms] ${url}`)),
        deadlineMs,
      );
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`[WS ERROR] ${url}`));
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error(`[WS CLOSED] ${url}`));
      });
    });
  }

  function esperarEventoPedido(
    ws: WebSocket,
    predicado: (e: EventoPedido) => boolean,
    deadlineMs = 15_000,
  ): Promise<EventoPedido> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener("message", onMessage);
        reject(new Error(`[WS TIMEOUT ${deadlineMs}ms] pedido event not received`));
      }, deadlineMs);
      const onMessage = (event: MessageEvent): void => {
        try {
          const data = JSON.parse(String(event.data)) as EventoPedido;
          if (predicado(data)) {
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            resolve(data);
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.addEventListener("message", onMessage);
    });
  }

  test(
    "WS pedido event (Q-28): the cliente's socket receives the confirmado notification (registrarPago) and then the entregado one (marcarEntregado)",
    async () => {
      const cliente = await registrarClienteConLimite(adminToken, 1000);
      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 2 }] },
        cliente.token,
      );
      await must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: pedido.id }, vendedorToken);

      const tipos = await must<TipoPagoDto[]>("query", "pagos.tiposPago", {}, vendedorToken);
      const efectivo = tipos.find((t) => t.nombre === "Efectivo")!;

      const socket = await abrirSocket(`ws://localhost:3010/ws?token=${cliente.token}`);

      // The server publishes right after the mutation commits — the event can beat
      // the HTTP response round-trip, so each listener is armed BEFORE the call.
      const promesaConfirmado = esperarEventoPedido(
        socket,
        (e) => e.tipo === "pedido" && e.pedidoId === pedido.id && e.estadoNuevo === "confirmado",
      );
      await must<RegistrarPagoDto>(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: pedido.id, fkTipoPago: efectivo.id },
        vendedorToken,
      );
      const confirmado = await promesaConfirmado;
      expect(confirmado.folio).toBe(pedido.folio);
      expect(confirmado.mensaje).toContain(pedido.folio);

      const promesaEntregado = esperarEventoPedido(
        socket,
        (e) => e.tipo === "pedido" && e.pedidoId === pedido.id && e.estadoNuevo === "entregado",
      );
      await must<RegistrarPagoDto>(
        "mutation",
        "pagos.marcarEntregado",
        { fkPedido: pedido.id },
        vendedorToken,
      );
      const entregado = await promesaEntregado;
      expect(entregado.folio).toBe(pedido.folio);
      expect(entregado.mensaje).toContain("entregado");

      socket.close();
    },
    T,
  );
});
