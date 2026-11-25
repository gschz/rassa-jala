import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  aFechaCiclo,
  isoWeekFromMonday,
  mondayOfBusinessWeek,
  parseFechaCiclo,
} from "@rassa-jala/db/iso-semana";

import {
  ADMIN,
  CLIENTE,
  DEV_PASSWORD,
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
  type Fixture,
} from "./helpers";

const T = 240_000;

type PublicacionPushDoc = {
  id: string;
  fechaCiclo: string;
  estado: string;
  _deleted: boolean;
};
type ItemPushDoc = {
  id: string;
  fkPublicacion: string;
  fkProducto: string;
  fkUnidad?: string;
  precio: string;
  stock: number;
  estado: "activo" | "inactivo";
  _deleted: boolean;
};
type PublicacionPullDoc = {
  id: string;
  fkAgricultor: string | null;
  fechaCiclo: string;
  semanaIso: number;
  anioIso: number;
  estado: string;
  version: number;
  _deleted: boolean;
};
type ItemPullDoc = {
  id: string;
  fkPublicacion: string;
  fkProducto: string;
  fkUnidad: string;
  precio: string;
  stock: number;
  // G2: farmer name embedded server-side on pull (nullable when ownerless).
  agricultorNombre: string | null;
  version: number;
  _deleted: boolean;
};

type PushResultado = {
  operationId: string;
  docId: string;
  veredicto: "aplicada" | "conflicto" | "rechazada";
  motivo?: string;
  estadoServidor?: unknown;
};

const FARMER = "e2e-farmer@fixture.local";
const uuid = (): string => crypto.randomUUID();

/** A push that must fail transport-side (role gate, transient parent): capture it. */
async function pushFallido(
  fn: () => Promise<unknown>,
): Promise<{ message: string; status?: number }> {
  try {
    await fn();
  } catch (error) {
    const err = error as { message?: string; data?: { httpStatus?: number } };
    return { message: err.message ?? String(error), status: err.data?.httpStatus };
  }
  throw new Error("se esperaba que el push fallara");
}

describe("publicaciones-push e2e (offline draft lane, S2)", () => {
  let adminToken = "";
  let farmerToken = "";
  let clienteToken = "";
  let fx: Fixture;
  let proximo = "";
  let lunes = "";
  let qaActivoId = "";
  let qaInactivoId = "";
  let frijolId = "";
  let kgId = "";
  let draftId = "";
  let itemId = "";

  beforeAll(async () => {
    await ensureServer();
    adminToken = (await login(ADMIN, DEV_PASSWORD)).token;
    fx = await ensureFixtures();
    farmerToken = (await login(FARMER, DEV_PASSWORD)).token;
    clienteToken = (await login(CLIENTE, DEV_PASSWORD)).token;

    lunes = aFechaCiclo(mondayOfBusinessWeek(new Date()));
    proximo = aFechaCiclo(new Date(parseFechaCiclo(lunes).getTime() + 7 * 86_400_000));
    qaActivoId = fx.qaActivoId;
    qaInactivoId = fx.qaInactivoId;
    frijolId = (
      await pgQuery<{ id: string }>("select id from producto where nombre = 'Frijol' limit 1")
    )[0]!.id;
    kgId = (
      await pgQuery<{ id: string }>("select id from unidad where abreviatura = 'kg' limit 1")
    )[0]!.id;
  }, 90_000);

  /** Re-run convergence via the online API only: cancel any draft left on the ciclo. */
  const cancelarCiclo = async (): Promise<void> => {
    const lista = await must<{ id: string; fechaCiclo: string; version: number; estado: string }[]>(
      "query",
      "publicaciones.misPublicaciones",
      { fkAgricultor: fx.farmerId },
      farmerToken,
    );
    const activa = lista.find((p) => p.fechaCiclo === proximo && p.estado !== "cancelado");
    if (activa) {
      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: activa.id, version: activa.version },
        farmerToken,
      );
    }
  };

  const pushPubs = (operaciones: unknown[]): Promise<PushResultado[]> =>
    pushComo<PublicacionPushDoc>("publicaciones", operaciones as never[], farmerToken);

  const pushItems = (operaciones: unknown[]): Promise<PushResultado[]> =>
    pushComo<ItemPushDoc>("productosSemanales", operaciones as never[], farmerToken);

  test(
    "offline draft create pushes as 'aplicada' (server-owned owner/ISO week) and PULL delivers it",
    async () => {
      await cancelarCiclo();
      draftId = uuid();
      const cp = await maxSeq("publicacion_semanal");
      const operationId = uuid();
      const res = await pushPubs([
        {
          operationId,
          docId: draftId,
          op: "create",
          nuevoEstado: { id: draftId, fechaCiclo: proximo, estado: "borrador", _deleted: false },
          versionAsumida: null,
        },
      ]);
      expect(res).toHaveLength(1);
      expect(res[0]?.veredicto).toBe("aplicada");

      const fila = await pgUna<{
        fkAgricultor: string;
        fechaCiclo: string;
        semanaIso: number;
        anioIso: number;
        estado: string;
        version: number;
      }>(
        `select fk_agricultor as "fkAgricultor", to_char(fecha_ciclo, 'YYYY-MM-DD') as "fechaCiclo",
              semana_iso as "semanaIso", anio_iso as "anioIso", estado, version::int
       from publicacion_semanal where id = $1`,
        [draftId],
      );
      const semana = isoWeekFromMonday(parseFechaCiclo(proximo));
      expect(fila.fkAgricultor).toBe(fx.farmerId);
      expect(fila.fechaCiclo).toBe(proximo);
      expect(fila.semanaIso).toBe(semana.semanaIso);
      expect(fila.anioIso).toBe(semana.anioIso);
      expect(fila.estado).toBe("borrador");
      expect(fila.version).toBe(1);

      const op = await pgUna<{
        coleccion: string;
        veredicto: string;
        op: string;
        fkUsuario: string;
      }>(
        'select coleccion, veredicto, op, fk_usuario as "fkUsuario" from sync_operacion where id = $1',
        [operationId],
      );
      expect(op.coleccion).toBe("publicaciones");
      expect(op.veredicto).toBe("aplicada");
      expect(op.op).toBe("create");
      expect(op.fkUsuario).toBe(fx.farmerId);

      // The outbox row rides the same tx → PULL (farmer) delivers the doc, pending cleared.
      const docs = await pullHasta<PublicacionPullDoc>("publicaciones", cp, farmerToken, (ds) =>
        ds.some((d) => d.id === draftId),
      );
      const doc = docs.find((d) => d.id === draftId);
      expect(doc?.estado).toBe("borrador");
      expect(doc?.version).toBe(1);
      expect(doc?._deleted).toBe(false);

      // Buyers never see a draft: the same collection PULL returns nothing for it.
      await madurarOutbox(cp);
      const comoCliente = await pullUna<PublicacionPullDoc>("publicaciones", cp, clienteToken);
      expect(comoCliente.documentos.some((d) => d.id === draftId)).toBe(false);
    },
    T,
  );

  test(
    "replaying the same operationId returns the stored verdict with NO new PG effects",
    async () => {
      const operationId = uuid();
      const op = {
        operationId,
        docId: uuid(),
        op: "create" as const,
        nuevoEstado: { id: "", fechaCiclo: proximo, estado: "borrador", _deleted: false },
        versionAsumida: null,
      };
      // Duplicate ciclo → rechazada; the verdict must be stored and replayed verbatim.
      const primera = await pushPubs([op]);
      expect(primera[0]?.veredicto).toBe("rechazada");
      expect(primera[0]?.motivo).toBe(`Ya existe una publicación para el ciclo del ${proximo}`);

      const cambiosAntes = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_cambio where id_fila = $1",
        [op.docId],
      );
      const segunda = await pushPubs([op]);
      expect(segunda[0]?.veredicto).toBe("rechazada");
      expect(segunda[0]?.motivo).toBe(primera[0]?.motivo);
      const cambiosDespues = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_cambio where id_fila = $1",
        [op.docId],
      );
      expect(cambiosDespues.n).toBe(cambiosAntes.n);
      expect(cambiosAntes.n).toBe(0);
      // Exactly ONE registry row for the operation (the replay must not duplicate it).
      const ops = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_operacion where id = $1",
        [operationId],
      );
      expect(ops.n).toBe(1);
    },
    T,
  );

  test(
    "state transitions and physical deletes never travel as push docs",
    async () => {
      const publicado = await pushPubs([
        {
          operationId: uuid(),
          docId: uuid(),
          op: "create",
          nuevoEstado: { id: "", fechaCiclo: proximo, estado: "publicado", _deleted: false },
          versionAsumida: null,
        },
      ]);
      expect(publicado[0]?.veredicto).toBe("rechazada");
      expect(publicado[0]?.motivo).toBe(
        "La publicación se confirma solo en línea (publicar/cancelar/cerrar)",
      );
      const ghost = publicado[0]?.estadoServidor as { id?: string; _deleted?: boolean } | undefined;
      expect(ghost?._deleted).toBe(true);

      const noLunes = await pushPubs([
        {
          operationId: uuid(),
          docId: uuid(),
          op: "create",
          nuevoEstado: {
            id: "",
            fechaCiclo: aFechaCiclo(new Date(parseFechaCiclo(lunes).getTime() + 8 * 86_400_000)),
            estado: "borrador",
            _deleted: false,
          },
          versionAsumida: null,
        },
      ]);
      expect(noLunes[0]?.veredicto).toBe("rechazada");
      expect(noLunes[0]?.motivo).toBe("La fecha de ciclo debe ser un lunes (ISO 8601)");

      const borrado = await pushPubs([
        {
          operationId: uuid(),
          docId: draftId,
          op: "delete",
          nuevoEstado: { id: draftId, fechaCiclo: proximo, estado: "borrador", _deleted: true },
          versionAsumida: 1,
        },
      ]);
      expect(borrado[0]?.veredicto).toBe("rechazada");
      expect(borrado[0]?.motivo).toBe(
        "Las publicaciones no se eliminan físicamente; usa cancelar en línea",
      );
      expect((borrado[0]?.estadoServidor as { id?: string } | undefined)?.id).toBe(draftId);

      // Deleting a doc that never existed is a converging no-op (cleanup of local ghosts).
      const inexistente = await pushPubs([
        {
          operationId: uuid(),
          docId: uuid(),
          op: "delete",
          nuevoEstado: { id: "", fechaCiclo: proximo, estado: "borrador", _deleted: true },
          versionAsumida: null,
        },
      ]);
      expect(inexistente[0]?.veredicto).toBe("aplicada");
      expect(inexistente[0]?.motivo).toBe("delete de fila inexistente; no-op");
    },
    T,
  );

  test(
    "update rides the version CAS: stale/null → conflicto, ciclo change → rechazada",
    async () => {
      const base = {
        id: draftId,
        fechaCiclo: proximo,
        estado: "borrador",
        _deleted: false,
      };

      const stale = await pushPubs([
        {
          operationId: uuid(),
          docId: draftId,
          op: "update",
          nuevoEstado: base,
          versionAsumida: 99,
        },
      ]);
      expect(stale[0]?.veredicto).toBe("conflicto");
      expect((stale[0]?.estadoServidor as { version?: number } | undefined)?.version).toBe(1);
      const sinCambios = await pgUna<{ version: number }>(
        "select version::int from publicacion_semanal where id = $1",
        [draftId],
      );
      expect(sinCambios.version).toBe(1);

      const nula = await pushPubs([
        {
          operationId: uuid(),
          docId: draftId,
          op: "update",
          nuevoEstado: base,
          versionAsumida: null,
        },
      ]);
      expect(nula[0]?.veredicto).toBe("conflicto");

      const movida = await pushPubs([
        {
          operationId: uuid(),
          docId: draftId,
          op: "update",
          nuevoEstado: {
            ...base,
            fechaCiclo: aFechaCiclo(new Date(parseFechaCiclo(proximo).getTime() - 7 * 86_400_000)),
          },
          versionAsumida: 1,
        },
      ]);
      expect(movida[0]?.veredicto).toBe("rechazada");
      expect(movida[0]?.motivo).toBe("El ciclo de una publicación no puede modificarse");

      const aplicada = await pushPubs([
        { operationId: uuid(), docId: draftId, op: "update", nuevoEstado: base, versionAsumida: 1 },
      ]);
      expect(aplicada[0]?.veredicto).toBe("aplicada");
      const v2 = await pgUna<{ version: number }>(
        "select version::int from publicacion_semanal where id = $1",
        [draftId],
      );
      expect(v2.version).toBe(2);
    },
    T,
  );

  test(
    "item create pushes aplicada, inherits the maestro unidad and PULLs to the farmer",
    async () => {
      itemId = uuid();
      const cp = await maxSeq("producto_semanal");
      const res = await pushItems([
        {
          operationId: uuid(),
          docId: itemId,
          op: "create",
          nuevoEstado: {
            id: itemId,
            fkPublicacion: draftId,
            fkProducto: qaActivoId,
            precio: "3.50",
            stock: 4,
            estado: "activo",
            _deleted: false,
          },
          versionAsumida: null,
        },
      ]);
      expect(res[0]?.veredicto).toBe("aplicada");

      const fila = await pgUna<{
        fkPublicacion: string;
        fkUnidad: string;
        precio: string;
        stock: number;
        version: number;
      }>(
        `select fk_publicacion as "fkPublicacion", fk_unidad as "fkUnidad",
              precio::text as precio, stock, version::int from producto_semanal where id = $1`,
        [itemId],
      );
      expect(fila.fkPublicacion).toBe(draftId);
      expect(fila.fkUnidad).toBe(kgId);
      expect(Number(fila.precio)).toBe(3.5);
      expect(fila.stock).toBe(4);
      expect(fila.version).toBe(1);

      const docs = await pullHasta<ItemPullDoc>("productosSemanales", cp, farmerToken, (ds) =>
        ds.some((d) => d.id === itemId),
      );
      const doc = docs.find((d) => d.id === itemId);
      expect(doc?.fkPublicacion).toBe(draftId);
      expect(Number(doc?.precio)).toBe(3.5);
      expect(doc?._deleted).toBe(false);
    },
    T,
  );

  test(
    "item create rejections: duplicate offer, inactive maestro, missing unidad, foreign/published parent",
    async () => {
      const opItem = (nuevo: Record<string, unknown>): unknown[] => [
        {
          operationId: uuid(),
          docId: uuid(),
          op: "create",
          nuevoEstado: { estado: "activo", _deleted: false, precio: "2.00", stock: 1, ...nuevo },
          versionAsumida: null,
        },
      ];
      const base = { fkPublicacion: draftId, fkProducto: qaActivoId };

      const duplicado = await pushItems(opItem(base));
      expect(duplicado[0]?.veredicto).toBe("rechazada");
      expect(duplicado[0]?.motivo).toBe("Ese producto ya está en la publicación");

      const inactivo = await pushItems(
        opItem({ fkPublicacion: draftId, fkProducto: qaInactivoId }),
      );
      expect(inactivo[0]?.veredicto).toBe("rechazada");
      expect(inactivo[0]?.motivo).toBe("El producto maestro no existe o está inactivo");

      // Frijol is active but has NO unidad and the push sends none → nothing to inherit.
      const sinUnidad = await pushItems(opItem({ fkPublicacion: draftId, fkProducto: frijolId }));
      expect(sinUnidad[0]?.veredicto).toBe("rechazada");
      expect(sinUnidad[0]?.motivo).toBe("La unidad es requerida");

      const ajeno = await pushItems(
        opItem({ fkPublicacion: fx.pubOtroId, fkProducto: qaActivoId }),
      );
      expect(ajeno[0]?.veredicto).toBe("rechazada");
      expect(ajeno[0]?.motivo).toBe("La publicación no es tuya");

      const publicado = await pushItems(
        opItem({ fkPublicacion: fx.pubActualId, fkProducto: qaActivoId }),
      );
      expect(publicado[0]?.veredicto).toBe("rechazada");
      expect(publicado[0]?.motivo).toBe(
        "Solo los borradores aceptan cambios de artículos; la confirmación es en línea",
      );

      // No ghost rows from any rejection.
      const filas = await pgQuery<{ id: string }>(
        "select id from producto_semanal where fk_publicacion in ($1, $2) and fk_producto in ($3, $4)",
        [draftId, fx.pubActualId, qaActivoId, qaInactivoId],
      );
      expect(filas.map((f) => f.id)).toEqual([itemId]);
    },
    T,
  );

  test(
    "missing parent publication is TRANSIENT (5xx retry, no verdict persisted)",
    async () => {
      const operationId = uuid();
      const fallo = await pushFallido(() =>
        pushItems([
          {
            operationId,
            docId: uuid(),
            op: "create",
            nuevoEstado: {
              id: "",
              fkPublicacion: uuid(),
              fkProducto: qaActivoId,
              precio: "2.00",
              stock: 1,
              estado: "activo",
              _deleted: false,
            },
            versionAsumida: null,
          },
        ]),
      );
      expect(fallo.message).toContain("aún no está sincronizada");
      const registro = await pgQuery<{ id: string }>(
        "select id from sync_operacion where id = $1",
        [operationId],
      );
      expect(registro).toHaveLength(0);
    },
    T,
  );

  test(
    "orphan item of a REJECTED publication is rechazada + tombstone (no 5xx retry loop)",
    async () => {
      // A pub create that can never apply (online-only state) → persisted rechazada,
      // no row. Its items are orphans: legacy cascade semantics (W1) — orphans die.
      const pubRechazadaId = uuid();
      const pubOp = await pushPubs([
        {
          operationId: uuid(),
          docId: pubRechazadaId,
          op: "create",
          nuevoEstado: { id: "", fechaCiclo: proximo, estado: "publicado", _deleted: false },
          versionAsumida: null,
        },
      ]);
      expect(pubOp[0]?.veredicto).toBe("rechazada");

      const itemOpId = uuid();
      const res = await pushItems([
        {
          operationId: itemOpId,
          docId: uuid(),
          op: "create",
          nuevoEstado: {
            id: "",
            fkPublicacion: pubRechazadaId,
            fkProducto: qaActivoId,
            precio: "2.00",
            stock: 1,
            estado: "activo",
            _deleted: false,
          },
          versionAsumida: null,
        },
      ]);
      expect(res[0]?.veredicto).toBe("rechazada");
      expect(res[0]?.motivo).toBe(
        "La publicación del artículo fue rechazada o eliminada; el artículo se descarta",
      );
      const tomb = res[0]?.estadoServidor as { id?: string; _deleted?: boolean } | undefined;
      expect(tomb?._deleted).toBe(true);

      // The verdict persisted (a replay returns it — no transport error, no retry loop).
      const registro = await pgQuery<{ id: string }>(
        "select id from sync_operacion where id = $1",
        [itemOpId],
      );
      expect(registro).toHaveLength(1);
      // No ghost item row for the rejected parent.
      const filas = await pgQuery<{ id: string }>(
        "select id from producto_semanal where fk_publicacion = $1",
        [pubRechazadaId],
      );
      expect(filas).toHaveLength(0);
    },
    T,
  );

  test(
    "item update/delete: CAS stale → conflicto, move → rechazada, delete → rechazada",
    async () => {
      const doc = {
        id: itemId,
        fkPublicacion: draftId,
        fkProducto: qaActivoId,
        precio: "3.50",
        stock: 4,
        estado: "activo" as const,
        _deleted: false,
      };

      const stale = await pushItems([
        { operationId: uuid(), docId: itemId, op: "update", nuevoEstado: doc, versionAsumida: 9 },
      ]);
      expect(stale[0]?.veredicto).toBe("conflicto");
      expect((stale[0]?.estadoServidor as { version?: number } | undefined)?.version).toBe(1);

      // Moving needs a SECOND draft of the same farmer (the target parent is validated first).
      const otroCiclo = aFechaCiclo(new Date(parseFechaCiclo(proximo).getTime() + 7 * 86_400_000));
      const draft2 = uuid();
      const creada2 = await pushPubs([
        {
          operationId: uuid(),
          docId: draft2,
          op: "create",
          nuevoEstado: { id: draft2, fechaCiclo: otroCiclo, estado: "borrador", _deleted: false },
          versionAsumida: null,
        },
      ]);
      expect(creada2[0]?.veredicto).toBe("aplicada");

      const movido = await pushItems([
        {
          operationId: uuid(),
          docId: itemId,
          op: "update",
          nuevoEstado: { ...doc, fkPublicacion: draft2 },
          versionAsumida: 1,
        },
      ]);
      expect(movido[0]?.veredicto).toBe("rechazada");
      expect(movido[0]?.motivo).toBe("El artículo no puede moverse de publicación");

      // A different farmer's draft is rejected by the ownership gate before the move check.
      const ajeno = await pushItems([
        {
          operationId: uuid(),
          docId: itemId,
          op: "update",
          nuevoEstado: { ...doc, fkPublicacion: fx.pubOtroId },
          versionAsumida: 1,
        },
      ]);
      expect(ajeno[0]?.veredicto).toBe("rechazada");
      expect(ajeno[0]?.motivo).toBe("La publicación no es tuya");

      const borrar = await pushItems([
        { operationId: uuid(), docId: itemId, op: "delete", nuevoEstado: doc, versionAsumida: 1 },
      ]);
      expect(borrar[0]?.veredicto).toBe("rechazada");
      expect(borrar[0]?.motivo).toBe(
        "Los artículos se retiran cambiando su estado a inactivo; no se eliminan físicamente",
      );

      const aplicada = await pushItems([
        {
          operationId: uuid(),
          docId: itemId,
          op: "update",
          nuevoEstado: { ...doc, precio: "4.25", stock: 2, estado: "inactivo" },
          versionAsumida: 1,
        },
      ]);
      expect(aplicada[0]?.veredicto).toBe("aplicada");
      const fila = await pgUna<{ precio: string; stock: number; estado: string; version: number }>(
        "select precio::text as precio, stock, estado, version::int from producto_semanal where id = $1",
        [itemId],
      );
      expect(Number(fila.precio)).toBe(4.25);
      expect(fila.stock).toBe(2);
      expect(fila.estado).toBe("inactivo");
      expect(fila.version).toBe(2);

      // Free the extra ciclo for the next run (cancelado frees the uniqueness).
      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draft2, version: 1 },
        farmerToken,
      );
    },
    T,
  );

  test(
    "role gate is a per-op VERDICT (200 + rechazada), not a 403 (gap-pass-6 T3)",
    async () => {
      const pubOp = {
        operationId: uuid(),
        docId: uuid(),
        op: "create",
        nuevoEstado: { id: "", fechaCiclo: proximo, estado: "borrador", _deleted: false },
        versionAsumida: null,
      };
      const itemOp = {
        operationId: uuid(),
        docId: uuid(),
        op: "create",
        nuevoEstado: {
          id: "",
          fkPublicacion: draftId,
          fkProducto: qaActivoId,
          precio: "1.00",
          stock: 1,
          estado: "activo",
          _deleted: false,
        },
        versionAsumida: null,
      };

      const cliente = await pushComo("publicaciones", [pubOp] as never[], clienteToken);
      expect(cliente[0]?.veredicto).toBe("rechazada");
      expect(cliente[0]?.motivo).toBe(
        "Solo el rol Agricultor puede enviar borradores de publicaciones",
      );
      expect((cliente[0]?.estadoServidor as { _deleted?: boolean } | undefined)?._deleted).toBe(
        true,
      );

      const admin = await pushComo("publicaciones", [pubOp] as never[], adminToken);
      expect(admin[0]?.veredicto).toBe("rechazada");
      expect(admin[0]?.motivo).toBe(
        "Solo el rol Agricultor puede enviar borradores de publicaciones",
      );

      const clienteItems = await pushComo("productosSemanales", [itemOp] as never[], clienteToken);
      expect(clienteItems[0]?.veredicto).toBe("rechazada");
      expect(clienteItems[0]?.motivo).toBe(
        "Solo el rol Agricultor puede enviar artículos de borradores",
      );

      // The role rejection never touches the domain tables (no ghost rows).
      const pubFilas = await pgUna<{ n: number }>(
        "select count(*)::int n from publicacion_semanal where id = $1",
        [pubOp.docId],
      );
      expect(pubFilas.n).toBe(0);
      const itemFilas = await pgUna<{ n: number }>(
        "select count(*)::int n from producto_semanal where id = $1",
        [itemOp.docId],
      );
      expect(itemFilas.n).toBe(0);

      // The verdict persists (pedidos Rechazo out-of-tx pattern): the replay is idempotent.
      const ops = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_operacion where id = $1 and veredicto = 'rechazada'",
        [pubOp.operationId],
      );
      expect(ops.n).toBe(1);
    },
    T,
  );

  test(
    "cleanup: cancelling online leaves the stored 'aplicada' verdict replayable and does not resurrect",
    async () => {
      const operationId = uuid();
      // A fresh create is not possible on the same ciclo; replay the ORIGINAL create op
      // after the online cancel by using the stored one from test 1 (same docId/op).
      const replay = await pushPubs([
        {
          operationId,
          docId: draftId,
          op: "update",
          nuevoEstado: { id: draftId, fechaCiclo: proximo, estado: "borrador", _deleted: false },
          versionAsumida: 2,
        },
      ]);
      expect(replay[0]?.veredicto).toBe("aplicada");

      await must(
        "mutation",
        "publicaciones.cancelar",
        { publicacionId: draftId, version: 3 },
        farmerToken,
      );
      const cancelada = await pgUna<{ estado: string; version: number }>(
        "select estado, version::int from publicacion_semanal where id = $1",
        [draftId],
      );
      expect(cancelada.estado).toBe("cancelado");
      expect(cancelada.version).toBe(4);

      // Replaying the update operationId returns its stored verdict (no re-execution).
      const mismo = await pushPubs([
        {
          operationId,
          docId: draftId,
          op: "update",
          nuevoEstado: { id: draftId, fechaCiclo: proximo, estado: "borrador", _deleted: false },
          versionAsumida: 2,
        },
      ]);
      expect(mismo[0]?.veredicto).toBe("aplicada");
      const intacta = await pgUna<{ estado: string; version: number }>(
        "select estado, version::int from publicacion_semanal where id = $1",
        [draftId],
      );
      expect(intacta.estado).toBe("cancelado");
      expect(intacta.version).toBe(4);
    },
    T,
  );
});
