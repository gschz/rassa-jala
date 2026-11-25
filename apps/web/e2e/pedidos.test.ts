import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN,
  AGRO,
  DEV_PASSWORD,
  VENDEDOR,
  VENDEDOR2,
  ensureFixtures,
  ensureServer,
  login,
  madurarOutbox,
  maxSeq,
  must,
  pgQuery,
  pgUna,
  pullHasta,
  pullUna,
  pushComo,
  sufijo,
  tokenDe,
  trpc,
  type Fixture,
} from "./helpers";

const T = 240_000;

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

type PedidoPullDoc = {
  id: string;
  folio?: string;
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
  detalles?: Array<{
    id: string;
    fkProductoSemanal: string;
    nombreProducto: string;
    cantidad: number;
    precioUnitario: string;
    importe: string;
  }>;
  _deleted: boolean;
};

type FamiliaDto = {
  id: string;
  nombre: string;
  fkJefeUsuario: string | null;
  estado: boolean;
  version: number;
  limite: { id: string; monto: string; estado: boolean; version: number } | null;
  miembros: Array<{
    membresiaId: string;
    usuarioId: string;
    correo: string;
    esJefe: boolean;
    estado: boolean;
    version: number;
  }>;
};

type RegistroOk = { ok: true; correo: string };

async function localidadActivaId(): Promise<string> {
  return (await pgUna<{ id: string }>("select id from localidad where estado order by id limit 1"))
    .id;
}

async function registrarCliente(
  email: string,
  password: string,
  fkLocalidad: string,
): Promise<string> {
  await must<RegistroOk>("mutation", "usuarios.register", {
    email,
    password,
    nombre: "Cliente",
    apellidoPaterno: `Ped${sufijo()}`,
    fkLocalidad,
  });
  return (await login(email, password)).user.id;
}

async function crearFamiliaConLimite(
  adminToken: string,
  jefeEmail: string,
  montoLimite: number,
  nombre: string,
): Promise<FamiliaDto> {
  return must<FamiliaDto>(
    "mutation",
    "familias.create",
    { nombre, jefeEmail, montoLimite },
    adminToken,
  );
}

/** The canonical money-proof cart: 10.13 × (1 + 2 + 3). */
function carritoDinero(fx: Fixture): { fkProductoSemanal: string; cantidad: number }[] {
  return [
    { fkProductoSemanal: fx.itemMoneyId, cantidad: 1 },
    { fkProductoSemanal: fx.itemMoney2Id, cantidad: 2 },
    { fkProductoSemanal: fx.itemMoney3Id, cantidad: 3 },
  ];
}

describe("pedidos e2e (p0-pedidos proofs)", () => {
  let adminToken = "";
  let clienteToken = "";
  let vendedorToken = "";
  let vendedorId = "";
  let vendedor2Token = "";
  let vendedor2Id = "";
  let fx: Fixture;
  let localidadId = "";

  beforeAll(async () => {
    await ensureServer();
    const admin = await login(ADMIN, DEV_PASSWORD);
    adminToken = admin.token;
    fx = await ensureFixtures();
    localidadId = await localidadActivaId();

    const clientEmail = `ped-cliente-${sufijo()}@e2e.local`;
    await registrarCliente(clientEmail, "ClienteE2E123", localidadId);
    clienteToken = (await login(clientEmail, "ClienteE2E123")).token;

    const vendSes = await login(VENDEDOR, DEV_PASSWORD);
    vendedorToken = vendSes.token;
    vendedorId = vendSes.user.id;

    const vend2Ses = await login(VENDEDOR2, DEV_PASSWORD);
    vendedor2Token = vend2Ses.token;
    vendedor2Id = vend2Ses.user.id;
  }, 90_000);

  test(
    "checkout money exactness: 10.13×[1,2,3] → 60.78 / 9.72 / 70.50 snapshots",
    async () => {
      const s = sufijo();
      const jefeEmail = `ped-dinero-${s}@e2e.local`;
      const jefeId = await registrarCliente(jefeEmail, "ClienteE2E123", localidadId);
      await crearFamiliaConLimite(adminToken, jefeEmail, 200, `Pedido Dinero ${s}`);
      const token = (await login(jefeEmail, "ClienteE2E123")).token;

      const cp = await maxSeq("pedido_cabecera");
      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: carritoDinero(fx) },
        token,
      );

      expect(pedido.estadoNombre).toBe("pendiente");
      expect(pedido.fkCliente).toBe(jefeId);
      expect(pedido.fkVendedor).toBeNull();
      expect(pedido.origen).toBe("digital");
      expect(pedido.subtotal).toBe("60.78");
      expect(pedido.iva).toBe("9.72");
      expect(pedido.total).toBe("70.50");
      expect(pedido.detalles).toHaveLength(3);

      const fila = await pgUna<{ subtotal: string; iva: string; total: string }>(
        "select subtotal::text as subtotal, iva::text as iva, total::text as total from pedido_cabecera where id = $1",
        [pedido.id],
      );
      expect(fila.subtotal).toBe("60.78");
      expect(fila.iva).toBe("9.72");
      expect(fila.total).toBe("70.50");

      const detalles = await pgQuery<{
        cantidad: number;
        precioUnitario: string;
        importe: string;
        nombreProducto: string;
      }>(
        `select cantidad, precio_unitario::text as "precioUnitario", importe::text as importe,
              nombre_producto as "nombreProducto"
       from detalle_pedido where fk_pedido = $1 order by nombre_producto`,
        [pedido.id],
      );
      expect(detalles).toHaveLength(3);
      const importes = detalles.map((d) => Number(d.importe));
      expect(importes.reduce((a, b) => a + b, 0)).toBe(60.78);
      for (const detalle of detalles) {
        expect(detalle.precioUnitario).toBe("10.13");
      }

      const outbox = await pgQuery<{ tabla: string; operacion: string; actor: string }>(
        `select tabla_origen as tabla, operacion, actor from sync_cambio
       where tabla_origen in ('pedido_cabecera','detalle_pedido','producto_semanal')
         and actor = (select id::text from usuario where correo = $1)
       order by tabla_origen`,
        [jefeEmail],
      );
      expect(outbox.length).toBe(1 + 3 + 3);

      const docs = await pullHasta<PedidoPullDoc>("pedidos", cp, token, (ds) =>
        ds.some((d) => d.id === pedido.id),
      );
      const doc = docs.find((d) => d.id === pedido.id);
      expect(doc?.subtotal).toBe("60.78");
      expect(doc?.iva).toBe("9.72");
      expect(doc?.total).toBe("70.50");
      expect(doc?.detalles).toHaveLength(3);
    },
    T,
  );

  test(
    "checkout stock decrement and insufficient-stock rejection leaves stock unchanged",
    async () => {
      const s = sufijo();
      const jefeEmail = `ped-stock-${s}@e2e.local`;
      await registrarCliente(jefeEmail, "ClienteE2E123", localidadId);
      await crearFamiliaConLimite(adminToken, jefeEmail, 200, `Pedido Stock ${s}`);
      const token = (await login(jefeEmail, "ClienteE2E123")).token;

      const stockInicial = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          fx.itemStockId,
        ])
      ).stock;

      const p1 = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemStockId, cantidad: 1 }] },
        token,
      );
      expect(p1.total).toBeDefined();
      const stock1 = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          fx.itemStockId,
        ])
      ).stock;
      expect(stock1).toBe(stockInicial - 1);

      const p2 = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemStockId, cantidad: 1 }] },
        token,
      );
      expect(p2.total).toBeDefined();
      const stock2 = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          fx.itemStockId,
        ])
      ).stock;
      expect(stock2).toBe(stockInicial - 2);

      // Try to buy more than the remaining stock.
      const rechazo = await trpc(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemStockId, cantidad: stockInicial }] },
        token,
      );
      expect(rechazo.ok).toBe(false);
      if (!rechazo.ok) {
        expect(rechazo.status).toBe(400);
        expect(rechazo.errorMessage).toContain("Stock insuficiente");
      }

      const stockFinal = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          fx.itemStockId,
        ])
      ).stock;
      expect(stockFinal).toBe(stockInicial - 2);

      const pedidosCreados = await pgQuery<{ n: number }>(
        "select count(*)::int n from pedido_cabecera where fk_cliente = (select id from usuario where correo = $1)",
        [jefeEmail],
      );
      expect(pedidosCreados[0]?.n).toBe(2);
    },
    T,
  );

  test(
    "checkout family credit accumulates and over-limit is rejected",
    async () => {
      const s = sufijo();
      const jefeEmail = `ped-credit-${s}@e2e.local`;
      await registrarCliente(jefeEmail, "ClienteE2E123", localidadId);
      await crearFamiliaConLimite(adminToken, jefeEmail, 200, `Pedido Credito ${s}`);
      const token = (await login(jefeEmail, "ClienteE2E123")).token;

      const p1 = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: carritoDinero(fx) },
        token,
      );
      expect(p1.total).toBe("70.50");

      const p2 = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: carritoDinero(fx) },
        token,
      );
      expect(p2.total).toBe("70.50");

      // Usage is 141.00; a third identical order exceeds the 200.00 family limit.
      const sobre = await trpc("mutation", "pedidos.checkout", { items: carritoDinero(fx) }, token);
      expect(sobre.ok).toBe(false);
      if (!sobre.ok) {
        expect(sobre.status).toBe(400);
        expect(sobre.errorMessage).toContain("Límite de crédito insuficiente");
        expect(sobre.errorMessage).toContain("usado 141.00 de 200.00");
      }
    },
    T,
  );

  test(
    "checkout client without credit limit is rejected",
    async () => {
      const s = sufijo();
      const email = `ped-nolimit-${s}@e2e.local`;
      await registrarCliente(email, "ClienteE2E123", localidadId);
      const token = (await login(email, "ClienteE2E123")).token;

      const res = await trpc(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        token,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(400);
        expect(res.errorMessage).toBe("No tiene límite de crédito asignado");
      }
    },
    T,
  );

  test(
    "checkout individual credit limit works independently of family",
    async () => {
      const s = sufijo();
      const email = `ped-indiv-${s}@e2e.local`;
      const usuarioId = await registrarCliente(email, "ClienteE2E123", localidadId);
      await must<{ id: string; monto: string }>(
        "mutation",
        "familias.setLimite",
        { usuarioId, monto: 50 },
        adminToken,
      );
      const token = (await login(email, "ClienteE2E123")).token;

      const p1 = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        token,
      );
      expect(Number(p1.total)).toBeLessThanOrEqual(50);

      const sobre = await trpc(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 10 }] },
        token,
      );
      expect(sobre.ok).toBe(false);
      if (!sobre.ok) expect(sobre.status).toBe(400);
    },
    T,
  );

  test(
    "pedidoPresencial does not consume credit and auto-assigns the seller",
    async () => {
      const s = sufijo();
      const clienteNombre = `Cliente Físico ${s}`;
      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.pedidoPresencial",
        {
          clienteNombre,
          clienteTelefono: "3111234567",
          items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 2 }],
        },
        vendedorToken,
      );

      expect(pedido.fkCliente).toBeNull();
      expect(pedido.fkVendedor).toBe(vendedorId);
      expect(pedido.origen).toBe("presencial");
      expect(pedido.clienteNombre).toBe(clienteNombre);
      expect(pedido.clienteTelefono).toBe("3111234567");
      expect(pedido.estadoNombre).toBe("pendiente");

      const fila = await pgUna<{
        fkCliente: string | null;
        fkVendedor: string | null;
        origen: string;
        clienteNombre: string | null;
      }>(
        `select fk_cliente as "fkCliente", fk_vendedor as "fkVendedor", origen,
              cliente_nombre as "clienteNombre"
       from pedido_cabecera where id = $1`,
        [pedido.id],
      );
      expect(fila.fkCliente).toBeNull();
      expect(fila.fkVendedor).toBe(vendedorId);
      expect(fila.origen).toBe("presencial");
      expect(fila.clienteNombre).toBe(clienteNombre);
    },
    T,
  );

  test(
    "claim race: concurrent claims produce exactly one winner and one 409",
    async () => {
      const s = sufijo();
      const jefeEmail = `ped-claim-${s}@e2e.local`;
      await registrarCliente(jefeEmail, "ClienteE2E123", localidadId);
      await crearFamiliaConLimite(adminToken, jefeEmail, 200, `Pedido Claim ${s}`);
      const token = (await login(jefeEmail, "ClienteE2E123")).token;

      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        token,
      );
      expect(pedido.fkVendedor).toBeNull();

      const [a, b] = await Promise.all([
        trpc<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: pedido.id }, vendedorToken),
        trpc<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: pedido.id }, vendedor2Token),
      ]);

      const exitos = [a, b].filter((r) => r.ok).length;
      const conflictos = [a, b].filter((r) => !r.ok && r.status === 409).length;
      expect(exitos).toBe(1);
      expect(conflictos).toBe(1);

      const perdedor = [a, b].find((r) => !r.ok);
      expect(perdedor?.errorMessage).toBe(
        "El pedido ya fue reclamado por otro vendedor o ya no está pendiente",
      );

      const fila = await pgUna<{ fkVendedor: string | null }>(
        'select fk_vendedor as "fkVendedor" from pedido_cabecera where id = $1',
        [pedido.id],
      );
      expect(fila.fkVendedor).toBeOneOf([vendedorId, vendedor2Id]);
    },
    T,
  );

  test(
    "cancel restores stock and appends a historial row",
    async () => {
      const s = sufijo();
      const jefeEmail = `ped-cancel-${s}@e2e.local`;
      await registrarCliente(jefeEmail, "ClienteE2E123", localidadId);
      await crearFamiliaConLimite(adminToken, jefeEmail, 200, `Pedido Cancel ${s}`);
      const token = (await login(jefeEmail, "ClienteE2E123")).token;

      const stockInicial = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          fx.itemStockId,
        ])
      ).stock;

      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemStockId, cantidad: 3 }] },
        token,
      );
      const stockDurante = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          fx.itemStockId,
        ])
      ).stock;
      expect(stockDurante).toBe(stockInicial - 3);

      const cancelado = await must<PedidoDto>(
        "mutation",
        "pedidos.cancelar",
        { pedidoId: pedido.id, version: pedido.version },
        token,
      );
      expect(cancelado.estadoNombre).toBe("cancelado");

      const stockFinal = (
        await pgUna<{ stock: number }>("select stock from producto_semanal where id = $1", [
          fx.itemStockId,
        ])
      ).stock;
      expect(stockFinal).toBe(stockInicial);

      const historial = await pgQuery<{ estadoNombre: string }>(
        `select e.nombre as "estadoNombre"
       from historial_estado_pedido h
       join estado_pedido e on e.id = h.fk_estado
       where h.fk_pedido = $1
       order by h.fecha`,
        [pedido.id],
      );
      expect(historial.map((h) => h.estadoNombre)).toEqual(["pendiente", "cancelado"]);
    },
    T,
  );

  test(
    "push replay: same operationId returns stored verdict with unchanged PG counts",
    async () => {
      const s = sufijo();
      const jefeEmail = `ped-replay-${s}@e2e.local`;
      await registrarCliente(jefeEmail, "ClienteE2E123", localidadId);
      await crearFamiliaConLimite(adminToken, jefeEmail, 200, `Pedido Replay ${s}`);
      const token = (await login(jefeEmail, "ClienteE2E123")).token;

      const operationId = crypto.randomUUID();
      const docId = crypto.randomUUID();
      const items = [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }];

      const op = {
        operationId,
        docId,
        op: "create" as const,
        nuevoEstado: { items, notas: null, _deleted: false },
        versionAsumida: null,
      };

      const primera = await pushComo<PedidoPullDoc>("pedidos", [op] as never[], token);
      expect(primera).toHaveLength(1);
      expect(primera[0]?.veredicto).toBe("aplicada");

      const cambiosAntes = await pgUna<{ n: number }>(
        `select count(*)::int n from sync_cambio
       where tabla_origen in ('pedido_cabecera','detalle_pedido','producto_semanal')
         and actor = (select id::text from usuario where correo = $1)`,
        [jefeEmail],
      );

      const segunda = await pushComo<PedidoPullDoc>("pedidos", [op] as never[], token);
      expect(segunda[0]?.veredicto).toBe("aplicada");

      const cambiosDespues = await pgUna<{ n: number }>(
        `select count(*)::int n from sync_cambio
       where tabla_origen in ('pedido_cabecera','detalle_pedido','producto_semanal')
         and actor = (select id::text from usuario where correo = $1)`,
        [jefeEmail],
      );
      expect(cambiosDespues.n).toBe(cambiosAntes.n);

      const ops = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_operacion where id = $1",
        [operationId],
      );
      expect(ops.n).toBe(1);

      const cab = await pgUna<{ n: number }>(
        "select count(*)::int n from pedido_cabecera where id = $1",
        [docId],
      );
      expect(cab.n).toBe(1);
    },
    T,
  );

  test(
    "push role gate is a per-op VERDICT: non-Cliente push -> 200 + rechazada, no order rows (gap-pass-6 T3)",
    async () => {
      const agroToken = await tokenDe(AGRO, DEV_PASSWORD);
      const operationId = crypto.randomUUID();
      const docId = crypto.randomUUID();
      const stockAntes = (
        await pgUna<{ stock: number }>("select stock::int from producto_semanal where id = $1", [
          fx.itemMoneyId,
        ])
      ).stock;
      const resultados = await pushComo<PedidoPullDoc>(
        "pedidos",
        [
          {
            operationId,
            docId,
            op: "create",
            nuevoEstado: {
              items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }],
              notas: null,
              _deleted: false,
            },
            versionAsumida: null,
          },
        ] as never[],
        agroToken,
      );
      expect(resultados[0]?.veredicto).toBe("rechazada");
      expect(resultados[0]?.motivo).toBe("Solo el rol Cliente puede enviar pedidos en cola");

      // The role rejection never reaches adjudication: no header, no stock decrement.
      const cab = await pgUna<{ n: number }>(
        "select count(*)::int n from pedido_cabecera where id = $1",
        [docId],
      );
      expect(cab.n).toBe(0);
      const stock = await pgUna<{ stock: number }>(
        "select stock::int from producto_semanal where id = $1",
        [fx.itemMoneyId],
      );
      expect(stock.stock).toBe(stockAntes);

      // The verdict persists (out-of-tx Rechazo pattern): the replay returns it (§7).
      const ops = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_operacion where id = $1 and veredicto = 'rechazada'",
        [operationId],
      );
      expect(ops.n).toBe(1);
    },
    T,
  );

  test(
    "role 403s enforce client/seller/admin boundaries",
    async () => {
      const agroToken = await tokenDe(AGRO, DEV_PASSWORD);

      const agroCheckout = await trpc(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        agroToken,
      );
      expect(agroCheckout.ok).toBe(false);
      if (!agroCheckout.ok) {
        expect(agroCheckout.status).toBe(403);
        expect(agroCheckout.errorMessage).toBe("Solo los clientes pueden crear pedidos");
      }

      const pres = await trpc(
        "mutation",
        "pedidos.pedidoPresencial",
        {
          clienteNombre: "X",
          items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }],
        },
        clienteToken,
      );
      expect(pres.ok).toBe(false);
      if (!pres.ok) {
        expect(pres.status).toBe(403);
        expect(pres.errorMessage).toBe("Solo los vendedores registran pedidos presenciales");
      }

      const s = sufijo();
      const jefeEmail = `ped-rol-${s}@e2e.local`;
      await registrarCliente(jefeEmail, "ClienteE2E123", localidadId);
      await crearFamiliaConLimite(adminToken, jefeEmail, 200, `Pedido Rol ${s}`);
      const token = (await login(jefeEmail, "ClienteE2E123")).token;
      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        token,
      );

      const claimClient = await trpc(
        "mutation",
        "pedidos.claimar",
        { pedidoId: pedido.id },
        clienteToken,
      );
      expect(claimClient.ok).toBe(false);
      if (!claimClient.ok) {
        expect(claimClient.status).toBe(403);
        expect(claimClient.errorMessage).toBe("Solo los vendedores pueden reclamar pedidos");
      }

      const claimAdmin = await trpc(
        "mutation",
        "pedidos.claimar",
        { pedidoId: pedido.id },
        adminToken,
      );
      expect(claimAdmin.ok).toBe(false);
      if (!claimAdmin.ok) {
        expect(claimAdmin.status).toBe(403);
        expect(claimAdmin.errorMessage).toBe("Solo los vendedores pueden reclamar pedidos");
      }

      const disp = await trpc("query", "pedidos.disponibles", {}, clienteToken);
      expect(disp.ok).toBe(false);
      if (!disp.ok) {
        expect(disp.status).toBe(403);
        expect(disp.errorMessage).toBe("Solo los vendedores consultan pedidos disponibles");
      }

      const reasig = await trpc(
        "mutation",
        "pedidos.reasignar",
        { pedidoId: pedido.id, fkVendedor: vendedorId },
        vendedorToken,
      );
      expect(reasig.ok).toBe(false);
      if (!reasig.ok) {
        expect(reasig.status).toBe(403);
        expect(reasig.errorMessage).toBe("Solo el rol Admin puede reasignar pedidos");
      }

      const list = await trpc("query", "pedidos.list", {}, vendedorToken);
      expect(list.ok).toBe(false);
      if (!list.ok) {
        expect(list.status).toBe(403);
        expect(list.errorMessage).toBe("Solo el rol Admin lista todos los pedidos");
      }
    },
    T,
  );

  test(
    "PULL scoping: client own, seller assigned, admin all",
    async () => {
      const s = sufijo();
      const jefeEmail = `ped-pull-${s}@e2e.local`;
      await registrarCliente(jefeEmail, "ClienteE2E123", localidadId);
      await crearFamiliaConLimite(adminToken, jefeEmail, 200, `Pedido Pull ${s}`);
      const token = (await login(jefeEmail, "ClienteE2E123")).token;

      const cp = await maxSeq("pedido_cabecera");
      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        token,
      );

      // Owner sees the order.
      const docsClient = await pullHasta<PedidoPullDoc>("pedidos", cp, token, (ds) =>
        ds.some((d) => d.id === pedido.id),
      );
      expect(docsClient.some((d) => d.id === pedido.id)).toBe(true);
      for (const doc of docsClient) {
        expect((doc as Record<string, unknown>).passwordHash).toBeUndefined();
      }

      // Another client does not see it.
      const s2 = sufijo();
      const otroEmail = `ped-otro-${s2}@e2e.local`;
      await registrarCliente(otroEmail, "ClienteE2E123", localidadId);
      const otroToken = (await login(otroEmail, "ClienteE2E123")).token;
      await madurarOutbox(cp);
      const docsOtro = await pullUna<PedidoPullDoc>("pedidos", cp, otroToken);
      expect(docsOtro.documentos.some((d) => d.id === pedido.id)).toBe(false);

      // Seller does not see it before claim.
      const docsVendBefore = await pullUna<PedidoPullDoc>("pedidos", cp, vendedorToken);
      expect(docsVendBefore.documentos.some((d) => d.id === pedido.id)).toBe(false);

      // After claim the assigned seller sees it.
      await must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: pedido.id }, vendedorToken);
      const docsVendAfter = await pullHasta<PedidoPullDoc>("pedidos", cp, vendedorToken, (ds) =>
        ds.some((d) => d.id === pedido.id),
      );
      expect(docsVendAfter.some((d) => d.id === pedido.id)).toBe(true);

      // Admin sees it.
      const docsAdmin = await pullHasta<PedidoPullDoc>("pedidos", cp, adminToken, (ds) =>
        ds.some((d) => d.id === pedido.id),
      );
      expect(docsAdmin.some((d) => d.id === pedido.id)).toBe(true);
    },
    T,
  );

  test(
    "admin reassign moves the order to another seller",
    async () => {
      const s = sufijo();
      const jefeEmail = `ped-reasig-${s}@e2e.local`;
      await registrarCliente(jefeEmail, "ClienteE2E123", localidadId);
      await crearFamiliaConLimite(adminToken, jefeEmail, 200, `Pedido Reasig ${s}`);
      const token = (await login(jefeEmail, "ClienteE2E123")).token;

      const pedido = await must<PedidoDto>(
        "mutation",
        "pedidos.checkout",
        { items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }] },
        token,
      );
      await must<PedidoDto>("mutation", "pedidos.claimar", { pedidoId: pedido.id }, vendedorToken);

      const reasignado = await must<PedidoDto>(
        "mutation",
        "pedidos.reasignar",
        { pedidoId: pedido.id, fkVendedor: vendedor2Id },
        adminToken,
      );
      expect(reasignado.fkVendedor).toBe(vendedor2Id);

      const fila = await pgUna<{ fkVendedor: string | null }>(
        'select fk_vendedor as "fkVendedor" from pedido_cabecera where id = $1',
        [pedido.id],
      );
      expect(fila.fkVendedor).toBe(vendedor2Id);
    },
    T,
  );

  test(
    "folio PED (M-19): formato y monotonia secuencial; carrera concurrente → folios distintos; backfill íntegro en PG; el folio viaja en el doc de PULL",
    async () => {
      const folioDe = (f: string): number => Number(f.slice(4));
      // PULL checkpoint BEFORE the first order: the folio must arrive in the doc.
      const cp = await maxSeq("pedido_cabecera");

      // Sequential: folios are unique and strictly increasing.
      const a = await must<PedidoDto>(
        "mutation",
        "pedidos.pedidoPresencial",
        {
          clienteNombre: `FolioA${sufijo()}`,
          items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }],
        },
        vendedorToken,
      );
      const b = await must<PedidoDto>(
        "mutation",
        "pedidos.pedidoPresencial",
        {
          clienteNombre: `FolioB${sufijo()}`,
          items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }],
        },
        vendedorToken,
      );
      expect(a.folio).toMatch(/^PED-\d{6}$/);
      expect(b.folio).toMatch(/^PED-\d{6}$/);
      expect(folioDe(b.folio)).toBeGreaterThan(folioDe(a.folio));

      // Race: two concurrent adjudications under the SAME advisory lock get DISTINCT
      // folios (folio_secuencia increment is serialized with the stock/credit lane).
      const [c, d] = await Promise.all([
        trpc<PedidoDto>(
          "mutation",
          "pedidos.pedidoPresencial",
          {
            clienteNombre: `FolioC${sufijo()}`,
            items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }],
          },
          vendedorToken,
        ),
        trpc<PedidoDto>(
          "mutation",
          "pedidos.pedidoPresencial",
          {
            clienteNombre: `FolioD${sufijo()}`,
            items: [{ fkProductoSemanal: fx.itemMoneyId, cantidad: 1 }],
          },
          vendedorToken,
        ),
      ]);
      expect(c.ok && d.ok).toBe(true);
      if (c.ok && d.ok) {
        expect(c.data.folio).not.toBe(d.data.folio);
        expect(c.data.folio).toMatch(/^PED-\d{6}$/);
        expect(d.data.folio).toMatch(/^PED-\d{6}$/);
      }

      // Backfill integrity (migration): EVERY existing row carries a non-null UNIQUE
      // folio, and the folio_secuencia row 'pedido' sits one past the largest.
      const bd = await pgUna<{
        total: number;
        distinct: number;
        nulos: number;
        maximo: string;
        siguiente: number;
      }>(
        `select count(*)::int total, count(distinct folio)::int distinct,
                count(*) filter (where folio is null)::int nulos,
                max(folio) maximo,
                (select siguiente from folio_secuencia where nombre = 'pedido') siguiente
         from pedido_cabecera`,
      );
      expect(bd.nulos).toBe(0);
      expect(bd.distinct).toBe(bd.total);
      expect(bd.maximo).toMatch(/^PED-\d{6}$/);
      expect(bd.siguiente).toBe(folioDe(bd.maximo) + 1);

      // The folio travels in the pedidos PULL doc (mis-pedidos/pedidos-vendedor lists).
      await madurarOutbox(cp);
      const docs = await pullUna<PedidoPullDoc>("pedidos", cp, vendedorToken);
      const doc = docs.documentos.find((x) => x.id === a.id);
      expect(doc?.folio).toBe(a.folio);
    },
    T,
  );
});
