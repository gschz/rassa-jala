import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  aFechaCiclo,
  esLunesNegocio,
  isoWeekFromMonday,
  mondayOfBusinessWeek,
  parseFechaCiclo,
} from "@rassa-jala/db/iso-semana";

import {
  ADMIN,
  BASE_URL,
  CLIENTE,
  DEV_PASSWORD,
  PNG_BYTES,
  TRPC_URL,
  VENDEDOR,
  ensureFixtures,
  ensureServer,
  login,
  maxSeq,
  must,
  pgQuery,
  PNG_BASE64,
  pullHasta,
  sufijo,
  trpc,
  type Fixture,
} from "./helpers";

const T = 240_000;

type ItemSemanalDto = {
  id: string;
  fkPublicacion: string;
  fkProducto: string;
  fkUnidad: string;
  precio: string;
  stock: number;
  estado: string;
  version: number;
};
type PublicacionDto = {
  id: string;
  fkAgricultor: string | null;
  fechaCiclo: string;
  semanaIso: number;
  anioIso: number;
  estado: string;
  version: number;
  items: ItemSemanalDto[];
};
type PublicacionPullDoc = {
  id: string;
  fkAgricultor: string | null;
  fechaCiclo: string;
  estado: string;
  version: number;
  _deleted: boolean;
};
type ItemSemanalPullDoc = {
  id: string;
  fkPublicacion: string;
  estado: string;
  version: number;
  _deleted: boolean;
};
type OfertaCatalogo = {
  id: string;
  fkPublicacion: string;
  fkProducto: string;
  nombre: string;
  abreviatura: string;
  precio: string;
  stock: number;
};

type ImagenPullDoc = {
  id: string;
  principal: boolean;
  _deleted: boolean;
};

const FARMER = "e2e-farmer@fixture.local";

describe("publicaciones e2e (p0-publicaciones proofs)", () => {
  let adminToken = "";
  let adminId = "";
  let farmerToken = "";
  let clienteToken = "";
  let vendedorToken = "";
  let fx: Fixture;
  let lunes = "";
  let proximo = "";
  /** A real Thursday (never Monday) for the crearBorrador date-format gate. */
  let jueves = "";
  /** Maestro ids used by the item proofs. */
  let tomateId = "";
  let frijolId = "";
  let kgId = "";

  beforeAll(async () => {
    await ensureServer();
    const admin = await login(ADMIN, DEV_PASSWORD);
    adminToken = admin.token;
    adminId = admin.user.id;
    // Fixtures first: the fixture users are SQL-provisioned (no seed row otherwise).
    fx = await ensureFixtures();
    farmerToken = (await login(FARMER, DEV_PASSWORD)).token;
    clienteToken = (await login(CLIENTE, DEV_PASSWORD)).token;
    vendedorToken = (await login(VENDEDOR, DEV_PASSWORD)).token;

    lunes = aFechaCiclo(mondayOfBusinessWeek(new Date()));
    proximo = aFechaCiclo(new Date(parseFechaCiclo(lunes).getTime() + 7 * 86_400_000));
    const miercoles = new Date(parseFechaCiclo(lunes).getTime() + 2 * 86_400_000);
    jueves = aFechaCiclo(miercoles);
    tomateId = (
      await pgQuery<{ id: string }>(
        "select id from producto where nombre = 'Tomate' and estado order by id limit 1",
      )
    )[0]!.id;
    frijolId = (
      await pgQuery<{ id: string }>(
        "select id from producto where nombre = 'Frijol' and estado order by id limit 1",
      )
    )[0]!.id;
    kgId = (
      await pgQuery<{ id: string }>("select id from unidad where abreviatura = 'kg' limit 1")
    )[0]!.id;
  }, 90_000);

  const misDe = (token: string, dueno: string): Promise<PublicacionDto[]> =>
    must<PublicacionDto[]>(
      "query",
      "publicaciones.misPublicaciones",
      { fkAgricultor: dueno },
      token,
    );

  /**
   * Re-run convergence WITHOUT extra SQL: a previous failed run may leave a
   * non-cancelled draft on the target ciclo. `cancelado` frees the ciclo (Q-25
   * partial unique), so cancelling first makes every run start from the same place.
   * A `publicado` pub is cancellable too; `cerrado` is terminal → caller decides.
   */
  const libreCiclo = async (
    token: string,
    dueno: string,
    fecha: string,
  ): Promise<string | null> => {
    const lista = await misDe(token, dueno);
    const activa = lista.find((p) => p.fechaCiclo === fecha && p.estado !== "cancelado");
    if (!activa) return null;
    if (activa.estado === "cerrado") return "cerrado";
    await must(
      "mutation",
      "publicaciones.cancelar",
      { publicacionId: activa.id, version: activa.version },
      token,
    );
    return null;
  };

  const borrador = async (token: string, dueno: string, fecha: string): Promise<PublicacionDto> => {
    await libreCiclo(token, dueno, fecha);
    return must<PublicacionDto>(
      "mutation",
      "publicaciones.crearBorrador",
      { fechaCiclo: fecha },
      token,
    );
  };

  test(
    "crearBorrador defaults to the current ciclo, derives the ISO week and writes the outbox row",
    async () => {
      // Admin owns no fixture publication, so the current ciclo is safe to converge.
      await libreCiclo(adminToken, adminId, lunes);
      const cp = await maxSeq("publicacion_semanal");
      const creada = await must<PublicacionDto>(
        "mutation",
        "publicaciones.crearBorrador",
        {},
        adminToken,
      );

      expect(creada.fechaCiclo).toBe(lunes);
      expect(creada.estado).toBe("borrador");
      expect(creada.version).toBe(1);
      expect(creada.items).toHaveLength(0);
      const { semanaIso, anioIso } = isoWeekFromMonday(parseFechaCiclo(lunes));
      expect(creada.semanaIso).toBe(semanaIso);
      expect(creada.anioIso).toBe(anioIso);

      const outbox = await pgQuery<{ operacion: string; actor: string }>(
        "select operacion, actor from sync_cambio where tabla_origen = 'publicacion_semanal' and id_fila = $1",
        [creada.id],
      );
      expect(outbox.length).toBe(1);
      expect(outbox[0]?.operacion).toBe("insert");
      expect(outbox[0]?.actor).toBe(adminId);

      const docs = await pullHasta<PublicacionPullDoc>("publicaciones", cp, adminToken, (ds) =>
        ds.some((d) => d.id === creada.id),
      );
      const doc = docs.find((d) => d.id === creada.id);
      expect(doc?.estado).toBe("borrador");
      expect(doc?.fechaCiclo).toBe(lunes);

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: creada.id, version: 1 },
        adminToken,
      );
    },
    T,
  );

  test(
    "crearBorrador: same ciclo -> 409; non-Monday fecha -> 400 (exact messages)",
    async () => {
      const draft = await borrador(farmerToken, fx.farmerId, proximo);
      const dup = await trpc(
        "mutation",
        "publicaciones.crearBorrador",
        { fechaCiclo: proximo },
        farmerToken,
      );
      expect(dup.ok).toBe(false);
      if (!dup.ok) {
        expect(dup.status).toBe(409);
        expect(dup.errorMessage).toBe(`Ya existe una publicación para el ciclo del ${proximo}`);
      }

      const noLunes = await trpc(
        "mutation",
        "publicaciones.crearBorrador",
        { fechaCiclo: jueves },
        farmerToken,
      );
      expect(noLunes.ok).toBe(false);
      if (!noLunes.ok) {
        expect(noLunes.status).toBe(400);
        expect(noLunes.errorMessage).toBe("La fecha de ciclo debe ser un lunes (ISO 8601)");
      }

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draft.id, version: 1 },
        farmerToken,
      );
    },
    T,
  );

  test(
    "agregarItem: inherits the maestro unidad, money as string, dup 409, Frijol's missing unidad 400, inactive maestro 400",
    async () => {
      const draft = await borrador(farmerToken, fx.farmerId, proximo);

      const item = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draft.id, fkProducto: tomateId, precio: "12.34", stock: 7 },
        farmerToken,
      );
      expect(item.fkUnidad).toBe(kgId);
      expect(item.precio).toBe("12.34");
      expect(item.stock).toBe(7);
      expect(item.estado).toBe("activo");
      expect(item.version).toBe(1);

      const dup = await trpc(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draft.id, fkProducto: tomateId, precio: "9.00", stock: 1 },
        farmerToken,
      );
      expect(dup.ok).toBe(false);
      if (!dup.ok) {
        expect(dup.status).toBe(409);
        expect(dup.errorMessage).toBe("Ese producto ya está en la publicación");
      }

      // Frijol is an active maestro WITHOUT unidad: the item cannot inherit one.
      const sinUnidad = await trpc(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draft.id, fkProducto: frijolId, precio: "4.00", stock: 2 },
        farmerToken,
      );
      expect(sinUnidad.ok).toBe(false);
      if (!sinUnidad.ok) {
        expect(sinUnidad.status).toBe(400);
        expect(sinUnidad.errorMessage).toBe("La unidad es requerida");
      }

      const inactivo = await trpc(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draft.id, fkProducto: fx.qaInactivoId, precio: "4.00", stock: 2 },
        farmerToken,
      );
      expect(inactivo.ok).toBe(false);
      if (!inactivo.ok) {
        expect(inactivo.status).toBe(400);
        expect(inactivo.errorMessage).toBe("El producto indicado no existe o está inactivo");
      }

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draft.id, version: 1 },
        farmerToken,
      );
    },
    T,
  );

  test(
    "editarItem CAS + quitarItem soft-delete keep the outbox in step",
    async () => {
      const draft = await borrador(farmerToken, fx.farmerId, proximo);
      const item = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draft.id, fkProducto: tomateId, precio: "12.34", stock: 7 },
        farmerToken,
      );

      const editado = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.editarItem",
        { id: item.id, version: 1, precio: "9.99", stock: 3 },
        farmerToken,
      );
      expect(editado.version).toBe(2);
      expect(editado.precio).toBe("9.99");
      expect(editado.stock).toBe(3);

      const stale = await trpc(
        "mutation",
        "publicaciones.editarItem",
        { id: item.id, version: 1, stock: 1 },
        farmerToken,
      );
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.status).toBe(409);
        expect(stale.errorMessage).toContain("Conflicto de versión");
        expect(stale.errorMessage).toContain("versión actual: 2");
        expect(stale.errorMessage).toContain("enviada: 1");
      }

      const quitado = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.quitarItem",
        { id: item.id, version: 2 },
        farmerToken,
      );
      expect(quitado.estado).toBe("inactivo");
      expect(quitado.version).toBe(3);

      const fila = await pgQuery<{ estado: string; version: number }>(
        "select estado, version::int from producto_semanal where id = $1",
        [item.id],
      );
      expect(fila[0]?.estado).toBe("inactivo");
      expect(fila[0]?.version).toBe(3);

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draft.id, version: 1 },
        farmerToken,
      );
    },
    T,
  );

  test(
    "publicar: Monday gate rejects a past ciclo and a future ciclo deterministically",
    async () => {
      const gate =
        "Las publicaciones solo pueden publicarse el lunes de su ciclo (America/Mazatlan)";

      // Future ciclo: today is never the Monday of NEXT week.
      const futuro = await borrador(farmerToken, fx.farmerId, proximo);
      await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: futuro.id, fkProducto: tomateId, precio: "5.00", stock: 5 },
        farmerToken,
      );
      const noEsSuLunes = await trpc(
        "mutation",
        "publicaciones.publicar",
        { publicacionId: futuro.id, version: 1 },
        farmerToken,
      );
      expect(noEsSuLunes.ok).toBe(false);
      if (!noEsSuLunes.ok) {
        expect(noEsSuLunes.status).toBe(409);
        expect(noEsSuLunes.errorMessage).toBe(gate);
      }
      expect(
        (
          await pgQuery<{ estado: string }>(
            "select estado from publicacion_semanal where id = $1",
            [futuro.id],
          )
        )[0]?.estado,
      ).toBe("borrador");

      // Past ciclo (Admin): the fixture farmer already publishes the past week.
      const pasado = aFechaCiclo(new Date(parseFechaCiclo(lunes).getTime() - 7 * 86_400_000));
      await libreCiclo(adminToken, adminId, pasado);
      const previa = await must<PublicacionDto>(
        "mutation",
        "publicaciones.crearBorrador",
        { fechaCiclo: pasado },
        adminToken,
      );
      const pasadoNo = await trpc(
        "mutation",
        "publicaciones.publicar",
        { publicacionId: previa.id, version: 1 },
        adminToken,
      );
      expect(pasadoNo.ok).toBe(false);
      if (!pasadoNo.ok) {
        expect(pasadoNo.status).toBe(409);
        expect(pasadoNo.errorMessage).toBe(gate);
      }

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: previa.id, version: 1 },
        adminToken,
      );
      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: futuro.id, version: 1 },
        farmerToken,
      );
    },
    T,
  );

  test(
    "publicar: Pu4 (active items, precio/stock > 0) — exercised only when business today is Monday",
    async () => {
      const esLunes = esLunesNegocio(new Date());
      const previo = await libreCiclo(adminToken, adminId, lunes);
      if (!esLunes) {
        // Non-Monday runs prove the gate (previous test); Pu4 is unreachable behind it.
        return;
      }
      if (previo === "cerrado") {
        // A previous Monday run already closed the ciclo's publication (terminal state).
        return;
      }
      const draft = await must<PublicacionDto>(
        "mutation",
        "publicaciones.crearBorrador",
        { fechaCiclo: lunes },
        adminToken,
      );
      const vacia = await trpc(
        "mutation",
        "publicaciones.publicar",
        { publicacionId: draft.id, version: 1 },
        adminToken,
      );
      expect(vacia.ok).toBe(false);
      if (!vacia.ok) {
        expect(vacia.status).toBe(400);
        expect(vacia.errorMessage).toBe("No hay productos activos para publicar");
      }

      const item = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draft.id, fkProducto: tomateId, precio: "0", stock: 0 },
        adminToken,
      );
      const invalidos = await trpc(
        "mutation",
        "publicaciones.publicar",
        { publicacionId: draft.id, version: 1 },
        adminToken,
      );
      expect(invalidos.ok).toBe(false);
      if (!invalidos.ok) {
        expect(invalidos.status).toBe(400);
        expect(invalidos.errorMessage).toContain(
          "Hay productos con precio o stock inválidos para publicar",
        );
      }

      const corregido = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.editarItem",
        { id: item.id, version: 1, precio: "1.50", stock: 1 },
        adminToken,
      );
      const publicada = await must<PublicacionDto>(
        "mutation",
        "publicaciones.publicar",
        { publicacionId: draft.id, version: 1 },
        adminToken,
      );
      expect(publicada.estado).toBe("publicado");
      expect(publicada.version).toBe(2);
      expect(publicada.items.find((i) => i.id === corregido.id)?.estado).toBe("activo");

      // Publish is borrador-only; closing needs a real end-of-cycle (Monday-run residual:
      // `cerrar` success is not proven here — only the 400 guard below).
      const otraVez = await trpc(
        "mutation",
        "publicaciones.publicar",
        { publicacionId: draft.id, version: 2 },
        adminToken,
      );
      expect(otraVez.ok).toBe(false);
      if (!otraVez.ok) {
        expect(otraVez.status).toBe(400);
        expect(otraVez.errorMessage).toBe(
          "Solo se puede publicar una publicación en estado borrador",
        );
      }

      // Cancel publishes too (Q-25 lifecycle) — this frees the ciclo for the next run.
      const cancelada = await must<PublicacionDto>(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draft.id, version: 2 },
        adminToken,
      );
      expect(cancelada.estado).toBe("cancelado");
      expect(cancelada.version).toBe(3);
    },
    T,
  );

  test(
    "lifecycle guards: cancel frees the ciclo; cerrar needs publicado; cancel/cerrar refuse the wrong state",
    async () => {
      const draft = await borrador(farmerToken, fx.farmerId, proximo);
      const cerradoMal = await trpc(
        "mutation",
        "publicaciones.cerrar",
        { publicacionId: draft.id, version: 1 },
        farmerToken,
      );
      expect(cerradoMal.ok).toBe(false);
      if (!cerradoMal.ok) {
        expect(cerradoMal.status).toBe(400);
        expect(cerradoMal.errorMessage).toBe(
          "Solo se puede cerrar una publicación en estado publicado",
        );
      }

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draft.id, version: 1 },
        farmerToken,
      );
      // Q-25 defect NOT inherited: a cancelled ciclo can be drafted again.
      const reintento = await must<PublicacionDto>(
        "mutation",
        "publicaciones.crearBorrador",
        { fechaCiclo: proximo },
        farmerToken,
      );
      expect(reintento.estado).toBe("borrador");

      const cancelarDosVeces = await trpc(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: reintento.id, version: 1 },
        farmerToken,
      );
      expect(cancelarDosVeces.ok).toBe(true);
      const yaCancelada = await trpc(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: reintento.id, version: 2 },
        farmerToken,
      );
      expect(yaCancelada.ok).toBe(false);
      if (!yaCancelada.ok) {
        expect(yaCancelada.status).toBe(400);
        expect(yaCancelada.errorMessage).toBe(
          "Solo se pueden cancelar publicaciones en borrador o publicadas",
        );
      }
    },
    T,
  );

  test(
    "roles: non-gestion 403 and ownership 403 with exact messages",
    async () => {
      const sinGestion = await trpc("mutation", "publicaciones.crearBorrador", {}, clienteToken);
      expect(sinGestion.ok).toBe(false);
      if (!sinGestion.ok) {
        expect(sinGestion.status).toBe(403);
        expect(sinGestion.errorMessage).toBe(
          "Solo los roles Agricultor o Admin pueden gestionar publicaciones",
        );
      }

      const vendedor = await trpc(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: fx.pubOtroId, fkProducto: tomateId, precio: "1.00", stock: 1 },
        vendedorToken,
      );
      expect(vendedor.ok).toBe(false);
      if (!vendedor.ok) {
        expect(vendedor.status).toBe(403);
        expect(vendedor.errorMessage).toBe(
          "Solo los roles Agricultor o Admin pueden gestionar publicaciones",
        );
      }

      const ajeno = await trpc(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: fx.pubOtroId, fkProducto: tomateId, precio: "1.00", stock: 1 },
        farmerToken,
      );
      expect(ajeno.ok).toBe(false);
      if (!ajeno.ok) {
        expect(ajeno.status).toBe(403);
        expect(ajeno.errorMessage).toBe("La publicación no es tuya");
      }

      const detalleAjeno = await trpc(
        "query",
        "publicaciones.detalle",
        { id: fx.pubOtroId },
        farmerToken,
      );
      expect(detalleAjeno.ok).toBe(false);
      if (!detalleAjeno.ok) {
        expect(detalleAjeno.status).toBe(403);
        expect(detalleAjeno.errorMessage).toBe("La publicación no es tuya");
      }

      const filtroAjeno = await trpc(
        "query",
        "publicaciones.misPublicaciones",
        { fkAgricultor: fx.farmer2Id },
        farmerToken,
      );
      expect(filtroAjeno.ok).toBe(false);
      if (!filtroAjeno.ok) {
        expect(filtroAjeno.status).toBe(403);
        expect(filtroAjeno.errorMessage).toBe("La publicación no es tuya");
      }

      const clienteDetalle = await trpc(
        "query",
        "publicaciones.detalle",
        { id: fx.pubActualId },
        clienteToken,
      );
      expect(clienteDetalle.ok).toBe(false);
      if (!clienteDetalle.ok) {
        expect(clienteDetalle.status).toBe(403);
        expect(clienteDetalle.errorMessage).toBe("La publicación no es tuya");
      }

      // Admin may manage ANY farmer's publication (Q-19).
      const adminDetalle = await must<PublicacionDto>(
        "query",
        "publicaciones.detalle",
        { id: fx.pubOtroId },
        adminToken,
      );
      expect(adminDetalle.id).toBe(fx.pubOtroId);
    },
    T,
  );

  test(
    "catalogoCliente: only published current-ciclo offers with active items (any authenticated role)",
    async () => {
      const catalogo = await must<{ fechaCiclo: string; ofertas: OfertaCatalogo[] }>(
        "query",
        "publicaciones.catalogoCliente",
        undefined,
        clienteToken,
      );
      expect(catalogo.fechaCiclo).toBe(lunes);
      const pubs = new Set(catalogo.ofertas.map((o) => o.fkPublicacion));
      expect(pubs.has(fx.pubActualId)).toBe(true);
      expect(pubs.has(fx.pubOtroId)).toBe(true);
      // Past ciclo and drafts never reach the buyer.
      expect(pubs.has(fx.pubPastId)).toBe(false);

      const tomate = catalogo.ofertas.find((o) => o.id === fx.itemActualId);
      expect(tomate?.nombre).toBe("Tomate");
      expect(tomate?.abreviatura).toBe("kg");
      expect(tomate?.precio).toBe("33.33");
      expect(tomate?.stock).toBe(5);
      expect(catalogo.ofertas.every((o) => o.stock >= 0 && /^\d+\.\d{2}$/.test(o.precio))).toBe(
        true,
      );
      // Every returned item belongs to a PUBLISHED current-ciclo publication (other
      // farmers/suites may publish too: the claim is the scoping, not the fixture set).
      const pubsDevueltas = [...new Set(catalogo.ofertas.map((o) => o.fkPublicacion))];
      const validas = await pgQuery<{ id: string }>(
        "select id from publicacion_semanal where id = any($1::uuid[]) and estado = 'publicado' and fecha_ciclo = $2::date",
        [pubsDevueltas, lunes],
      );
      expect(validas.length).toBe(pubsDevueltas.length);

      // The catalog is a read every authenticated role may use (Vendedor too).
      const comoVendedor = await must<{ fechaCiclo: string }>(
        "query",
        "publicaciones.catalogoCliente",
        undefined,
        vendedorToken,
      );
      expect(comoVendedor.fechaCiclo).toBe(lunes);
      // Unauthenticated access is rejected by the protected procedure.
      const anonimo = await fetch(`${TRPC_URL}/publicaciones.catalogoCliente?batch=1&input=%7B%7D`);
      expect(anonimo.ok).toBe(false);
    },
    T,
  );

  test(
    "PULL scoping: farmer own (all weeks), cliente published-current only, admin all",
    async () => {
      // Drafts created through the API in this run (cancelled at the end).
      const draftFarmer = await borrador(farmerToken, fx.farmerId, proximo);
      const itemDraft = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draftFarmer.id, fkProducto: tomateId, precio: "6.00", stock: 4 },
        farmerToken,
      );

      const cpPub = Math.min(fx.seqPubActual, fx.seqPubPast) - 1;
      const cpItem = Math.min(fx.seqItemActual, fx.seqItemPast) - 1;

      // Farmer: both own weeks plus the fresh draft, never the other farmer's publication.
      const pubsFarmer = await pullHasta<PublicacionPullDoc>(
        "publicaciones",
        cpPub,
        farmerToken,
        (ds) =>
          ds.some((d) => d.id === fx.pubActualId) &&
          ds.some((d) => d.id === fx.pubPastId) &&
          ds.some((d) => d.id === draftFarmer.id),
      );
      expect(pubsFarmer.some((d) => d.id === fx.pubOtroId)).toBe(false);

      const itemsFarmer = await pullHasta<ItemSemanalPullDoc>(
        "productosSemanales",
        cpItem,
        farmerToken,
        (ds) =>
          ds.some((d) => d.id === fx.itemActualId) &&
          ds.some((d) => d.id === fx.itemPastId) &&
          ds.some((d) => d.id === itemDraft.id),
      );
      expect(itemsFarmer.some((d) => d.id === fx.itemOtroId)).toBe(false);

      // Cliente: published CURRENT ciclo only — the past week and the farmer's draft never arrive.
      const pubsCliente = await pullHasta<PublicacionPullDoc>(
        "publicaciones",
        cpPub,
        clienteToken,
        (ds) => ds.some((d) => d.id === fx.pubActualId) && ds.some((d) => d.id === fx.pubOtroId),
      );
      expect(pubsCliente.some((d) => d.id === fx.pubPastId)).toBe(false);
      expect(pubsCliente.some((d) => d.id === draftFarmer.id)).toBe(false);
      expect(pubsCliente.find((d) => d.id === fx.pubActualId)?.estado).toBe("publicado");

      const itemsCliente = await pullHasta<ItemSemanalPullDoc>(
        "productosSemanales",
        cpItem,
        clienteToken,
        (ds) => ds.some((d) => d.id === fx.itemActualId) && ds.some((d) => d.id === fx.itemOtroId),
      );
      expect(itemsCliente.some((d) => d.id === fx.itemPastId)).toBe(false);
      expect(itemsCliente.some((d) => d.id === itemDraft.id)).toBe(false);

      // Admin: every publication and every item, including other farmers' and drafts.
      const pubsAdmin = await pullHasta<PublicacionPullDoc>(
        "publicaciones",
        cpPub,
        adminToken,
        (ds) =>
          ds.some((d) => d.id === fx.pubActualId) &&
          ds.some((d) => d.id === fx.pubPastId) &&
          ds.some((d) => d.id === fx.pubOtroId) &&
          ds.some((d) => d.id === draftFarmer.id),
      );
      expect(pubsAdmin).toHaveLength(new Set(pubsAdmin.map((d) => d.id)).size);

      const itemsAdmin = await pullHasta<ItemSemanalPullDoc>(
        "productosSemanales",
        cpItem,
        adminToken,
        (ds) => ds.some((d) => d.id === fx.itemPastId) && ds.some((d) => d.id === itemDraft.id),
      );
      expect(itemsAdmin.some((d) => d.id === fx.itemOtroId)).toBe(true);

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draftFarmer.id, version: 1 },
        farmerToken,
      );
    },
    T,
  );

  test(
    "weekly-item photos: upload targets the semanal owner (M-11 XOR) and rejects the wrong state",
    async () => {
      const draft = await borrador(farmerToken, fx.farmerId, proximo);
      const item = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draft.id, fkProducto: tomateId, precio: "7.00", stock: 2 },
        farmerToken,
      );
      const subida = await must<{ url: string; principal: boolean; orden: number }>(
        "mutation",
        "publicaciones.imagenes.upload",
        {
          fkProductoSemanal: item.id,
          fileName: `sem-${sufijo()}.png`,
          mimeType: "image/png",
          dataBase64: PNG_BASE64,
        },
        farmerToken,
      );
      expect(subida.principal).toBe(true);
      const fila = await pgQuery<{ fkProducto: string | null; fkProductoSemanal: string | null }>(
        'select fk_producto as "fkProducto", fk_producto_semanal as "fkProductoSemanal" from producto_imagen where fk_producto_semanal = $1',
        [item.id],
      );
      expect(fila.length).toBe(1);
      expect(fila[0]?.fkProducto).toBeNull();
      expect(fila[0]?.fkProductoSemanal).toBe(item.id);

      // A previous upload is not the owner's item → 403.
      const ajeno = await trpc(
        "mutation",
        "publicaciones.imagenes.upload",
        {
          fkProductoSemanal: fx.itemOtroId,
          fileName: "x.png",
          mimeType: "image/png",
          dataBase64: PNG_BASE64,
        },
        farmerToken,
      );
      expect(ajeno.ok).toBe(false);
      if (!ajeno.ok) {
        expect(ajeno.status).toBe(403);
        expect(ajeno.errorMessage).toBe("La publicación no es tuya");
      }

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draft.id, version: 1 },
        farmerToken,
      );
    },
    T,
  );

  test(
    "weekly-item photo via MULTIPART (gap 3): farmer-owned item accepts a binary PNG upload",
    async () => {
      const draft = await borrador(farmerToken, fx.farmerId, proximo);
      const item = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draft.id, fkProducto: tomateId, precio: "7.00", stock: 2 },
        farmerToken,
      );
      const form = new FormData();
      form.append("fkProductoSemanal", item.id);
      form.append("file", new File([PNG_BYTES], `item-${sufijo()}.png`, { type: "image/png" }));
      const res = await fetch(`${BASE_URL}/upload/imagenes`, {
        method: "POST",
        headers: { authorization: `Bearer ${farmerToken}` },
        body: form,
      });
      expect(res.status).toBe(200);
      const subida = (await res.json()) as { url: string; principal: boolean };
      expect(subida.principal).toBe(true);
      const fila = await pgQuery<{ n: number }>(
        "select count(*)::int n from producto_imagen where fk_producto_semanal = $1",
        [item.id],
      );
      expect(fila).toEqual([{ n: 1 }]);

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draft.id, version: 1 },
        farmerToken,
      );
    },
    T,
  );

  test(
    "weekly-item photo delete: role/ownership gates, promotes the next principal, last delete leaves none",
    async () => {
      const draft = await borrador(farmerToken, fx.farmerId, proximo);
      const item = await must<ItemSemanalDto>(
        "mutation",
        "publicaciones.agregarItem",
        { publicacionId: draft.id, fkProducto: tomateId, precio: "7.00", stock: 2 },
        farmerToken,
      );
      const subir = (fileName: string): Promise<{ id: string; url: string; version: number }> =>
        must<{ id: string; url: string; version: number }>(
          "mutation",
          "publicaciones.imagenes.upload",
          {
            fkProductoSemanal: item.id,
            fileName,
            mimeType: "image/png",
            dataBase64: PNG_BASE64,
          },
          farmerToken,
        );
      const primera = await subir(`del1-${sufijo()}.png`); // principal, orden 0
      const segunda = await subir(`del2-${sufijo()}.png`); // orden 1
      // Checkpoint AFTER the uploads: PULL range covers only the delete + promotion.
      const cp = await maxSeq("producto_imagen");

      // Cliente role → 403 (gestion gate, same as upload/setPrincipal).
      const rol = await trpc(
        "mutation",
        "publicaciones.imagenes.delete",
        { id: primera.id, version: 1 },
        clienteToken,
      );
      expect(rol.ok).toBe(false);
      if (!rol.ok) expect(rol.status).toBe(403);

      // Owner deletes the principal → the next by orden is promoted in the same tx.
      await must<{ ok: true }>(
        "mutation",
        "publicaciones.imagenes.delete",
        { id: primera.id, version: 1 },
        farmerToken,
      );
      const filas = await pgQuery<{ id: string; principal: boolean; version: number }>(
        "select id, principal, version::int from producto_imagen where fk_producto_semanal = $1 order by orden",
        [item.id],
      );
      expect(filas).toHaveLength(1);
      expect(filas[0]?.id).toBe(segunda.id);
      expect(filas[0]?.principal).toBe(true);
      expect(filas[0]?.version).toBe(2);
      // PULL delivers both the tombstone and the promotion (plain outbox update).
      const docs = await pullHasta<ImagenPullDoc>(
        "imagenes",
        cp,
        farmerToken,
        (ds) => ds.some((d) => d.id === primera.id) && ds.some((d) => d.id === segunda.id),
      );
      expect(docs.find((d) => d.id === primera.id)?._deleted).toBe(true);
      expect(docs.find((d) => d.id === segunda.id)?.principal).toBe(true);
      // The stored object is unlinked after the tx commits.
      expect((await fetch(`${BASE_URL}${primera.url}`)).status).toBe(404);

      // Deleting the last photo leaves the item without a principal (valid state).
      await must<{ ok: true }>(
        "mutation",
        "publicaciones.imagenes.delete",
        { id: segunda.id, version: filas[0]?.version ?? 1 },
        farmerToken,
      );
      const restantes = await pgQuery<{ id: string; fk_producto_semanal: string | null }>(
        "select id, fk_producto_semanal from producto_imagen where fk_producto_semanal = $1",
        [item.id],
      );
      expect(restantes).toEqual([]);

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draft.id, version: 1 },
        farmerToken,
      );
    },
    T,
  );
});
