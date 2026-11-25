import { describe, expect, test } from "bun:test";
import type { WithDeleted } from "rxdb/plugins/core";

import type { ItemSemanalDoc, MensajeDoc, PedidoDoc, PublicacionDoc } from "./database";
import {
  aplicarResultados,
  armarOperacionesPush,
  DUEÑO_DRAFT_POR_LANE,
  determinarOperacionPush,
  esProductoSemanalPropio,
  esRechazoTerminalHttp,
  modificadorDraftsPropios,
  normalizarMensajePush,
  registrarPublicacionesPropias,
  type FilaPush,
  type PushResultado,
} from "./push-ops";
import { getSyncStatus } from "./sync-status";

// T2 (gap-pass-6) — the 400-loop fix: the server push schemas demand
// `versionAsumida: positive().nullable()`; a local draft (version 0) deleted
// offline rode `versionAsumida: 0` on the wire, the whole batch 400'd, and RxDB
// re-pushed the same rows forever (masterWrite loop QA saw on sync.mensajes.push).

const docMensaje = (extra: Partial<WithDeleted<MensajeDoc>> = {}): WithDeleted<MensajeDoc> => ({
  id: crypto.randomUUID(),
  fkConversacion: crypto.randomUUID(),
  fkAutor: crypto.randomUUID(),
  autorNombre: null,
  contenido: "Hola.",
  tipo: "texto",
  archivoUrl: null,
  leido: false,
  editado: false,
  estado: true,
  version: 0,
  creadoEn: new Date().toISOString(),
  actualizadoEn: new Date().toISOString(),
  _deleted: false,
  ...extra,
});

describe("armarOperacionesPush (T2 wire guard)", () => {
  test("delete of a local-only draft: versionAsumida 0 → null (was the 400-loop trigger)", () => {
    const fila: FilaPush<MensajeDoc> = {
      newDocumentState: docMensaje({ _deleted: true, syncOpId: crypto.randomUUID() }),
      assumedMasterState: docMensaje({ version: 0 }),
    };
    const { operaciones } = armarOperacionesPush<MensajeDoc>([fila]);
    expect(operaciones).toHaveLength(1);
    expect(operaciones[0]?.op).toBe("delete");
    expect(operaciones[0]?.versionAsumida).toBeNull();
  });

  test("update of a server-confirmed doc: the real version passes through", () => {
    const fila: FilaPush<MensajeDoc> = {
      newDocumentState: docMensaje({ version: 3, syncOpId: undefined }),
      assumedMasterState: docMensaje({ version: 2 }),
    };
    const { operaciones } = armarOperacionesPush<MensajeDoc>([fila]);
    expect(operaciones[0]?.op).toBe("update");
    expect(operaciones[0]?.versionAsumida).toBe(2);
  });

  test("create without prior master state: versionAsumida null, op create", () => {
    const fila: FilaPush<MensajeDoc> = {
      newDocumentState: docMensaje({ syncOpId: crypto.randomUUID() }),
    };
    const { operaciones, apartadas } = armarOperacionesPush<MensajeDoc>([fila]);
    expect(apartadas).toHaveLength(0);
    expect(operaciones[0]?.op).toBe("create");
    expect(operaciones[0]?.versionAsumida).toBeNull();
  });

  test("operationId rides the local syncOpId (§7 stable between retries)", () => {
    const syncOpId = crypto.randomUUID();
    const fila: FilaPush<MensajeDoc> = { newDocumentState: docMensaje({ syncOpId }) };
    const { operaciones } = armarOperacionesPush<MensajeDoc>([fila]);
    expect(operaciones[0]?.operationId).toBe(syncOpId);
  });
});

describe("normalizarMensajePush (T2 contenido wire guard)", () => {
  const operacionCon = (
    contenido: MensajeDoc["contenido"],
  ): (() => ReturnType<typeof normalizarMensajePush>) => {
    return () =>
      normalizarMensajePush({
        operationId: crypto.randomUUID(),
        docId: crypto.randomUUID(),
        op: "create",
        nuevoEstado: docMensaje({ contenido }),
        versionAsumida: null,
      });
  };

  test("blank contenido → null on the wire (server answers a per-op verdict, no 400)", () => {
    const op = operacionCon("   ")();
    expect(op).not.toBeNull();
    expect(op?.nuevoEstado.contenido).toBeNull();
  });

  test("normal contenido passes trimmed and unchanged in meaning", () => {
    const op = operacionCon("  Hola mundo. ")();
    expect(op?.nuevoEstado.contenido).toBe("Hola mundo.");
  });

  test("oversized contenido → parked (null op): user data never mutated to fit the wire", () => {
    const op = operacionCon("x".repeat(2001))();
    expect(op).toBeNull();
  });

  test("boundary: 2000 chars exactly still travels", () => {
    const op = operacionCon("x".repeat(2000))();
    expect(op).not.toBeNull();
  });

  test("null contenido (legacy image-only shape) passes as-is", () => {
    const op = operacionCon(null)();
    expect(op?.nuevoEstado.contenido).toBeNull();
  });
});

describe("esRechazoTerminalHttp (T2 no-retry classifier)", () => {
  test("tRPC client error shape: data.httpStatus 400 → terminal", () => {
    expect(esRechazoTerminalHttp({ data: { httpStatus: 400, code: "BAD_REQUEST" } })).toBeTrue();
    expect(esRechazoTerminalHttp({ data: { httpStatus: 403, code: "FORBIDDEN" } })).toBeTrue();
  });

  test("401 stays retryable (auth refresh may succeed)", () => {
    expect(esRechazoTerminalHttp({ data: { httpStatus: 401, code: "UNAUTHORIZED" } })).toBeFalse();
  });

  test("5xx and network errors stay retryable", () => {
    expect(esRechazoTerminalHttp({ data: { httpStatus: 500 } })).toBeFalse();
    expect(esRechazoTerminalHttp(new Error("fetch failed"))).toBeFalse();
    expect(esRechazoTerminalHttp(undefined)).toBeFalse();
  });

  test("defensive: BAD_REQUEST code without numeric status → terminal", () => {
    expect(esRechazoTerminalHttp({ data: { code: "BAD_REQUEST" } })).toBeTrue();
  });
});

describe("determinarOperacionPush", () => {
  test("delete marker wins over prior state", () => {
    expect(
      determinarOperacionPush({ newDocumentState: { _deleted: true }, assumedMasterState: {} }),
    ).toBe("delete");
  });
  test("prior master state → update", () => {
    expect(determinarOperacionPush({ newDocumentState: {}, assumedMasterState: {} })).toBe(
      "update",
    );
  });
  test("neither → create", () => {
    expect(determinarOperacionPush({ newDocumentState: {} })).toBe("create");
  });
});

// T4 (gap-pass-6) — the unified lane contract: the per-lane draft-ownership
// registry (DATA PROTECTION: a foreign leftover draft pushed under the wrong
// identity would come back with a persisted rechazada verdict + tombstone that
// the server-wins conflictHandler applies — the owner's local draft is DELETED —
// and the stored operationId poisons the owner's replay), the productosSemanales
// indirect-ownership cache, and the unified `aplicarResultados` application
// (badge policy per lane).

const ID = "usuario-1";
const OTRO = "usuario-2";

describe("DUEÑO_DRAFT_POR_LANE (T4 ownership registry)", () => {
  test("pedidos: the draft's fkCliente (checkoutOffline creator stamp) decides", () => {
    expect(DUEÑO_DRAFT_POR_LANE.pedidos({ fkCliente: ID }, ID)).toBe(true);
    expect(DUEÑO_DRAFT_POR_LANE.pedidos({ fkCliente: OTRO }, ID)).toBe(false);
    expect(DUEÑO_DRAFT_POR_LANE.pedidos({ fkCliente: null }, ID)).toBe(false);
  });

  test("mensajes: the draft's fkAutor (chat.tsx creator stamp) decides", () => {
    expect(DUEÑO_DRAFT_POR_LANE.mensajes({ fkAutor: ID }, ID)).toBe(true);
    expect(DUEÑO_DRAFT_POR_LANE.mensajes({ fkAutor: OTRO }, ID)).toBe(false);
    expect(DUEÑO_DRAFT_POR_LANE.mensajes({ fkAutor: null }, ID)).toBe(false);
  });

  test("productosSemanales: indirect ownership via the local publications cache", () => {
    const pub = crypto.randomUUID();
    registrarPublicacionesPropias([{ id: pub, fkAgricultor: ID }], ID);
    expect(esProductoSemanalPropio({ fkPublicacion: pub })).toBe(true);
    // Foreign/unknown publication never owns an item.
    expect(esProductoSemanalPropio({ fkPublicacion: crypto.randomUUID() })).toBe(false);
    // A publication registered under ANOTHER identity is not added for this user.
    registrarPublicacionesPropias([{ id: crypto.randomUUID(), fkAgricultor: OTRO }], ID);
    expect(esProductoSemanalPropio({ fkPublicacion: "" })).toBe(false);
  });
});

describe("modificadorDraftsPropios (T4 lane modifiers)", () => {
  test("publicaciones: own draft passes, foreign draft is skipped (never sent)", () => {
    const modifier = modificadorDraftsPropios<PublicacionDoc>("publicaciones", ID);
    const propio = { id: crypto.randomUUID(), fkAgricultor: ID } as PublicacionDoc;
    expect(modifier(propio)).toBe(propio);
    const ajeno = { id: crypto.randomUUID(), fkAgricultor: OTRO } as PublicacionDoc;
    expect(modifier(ajeno)).toBeNull();
  });

  test("pedidos (soloBorradores): the optimistic patch (no syncOpId) stays out, own draft passes, foreign draft is skipped", () => {
    const modifier = modificadorDraftsPropios<PedidoDoc>("pedidos", ID, true);
    const parche = { id: crypto.randomUUID(), fkCliente: ID } as PedidoDoc;
    expect(modifier(parche)).toBeNull();
    const borradorPropio = {
      id: crypto.randomUUID(),
      fkCliente: ID,
      syncOpId: crypto.randomUUID(),
    } as PedidoDoc;
    expect(modifier(borradorPropio)).toBe(borradorPropio);
    const borradorAjeno = {
      id: crypto.randomUUID(),
      fkCliente: OTRO,
      syncOpId: crypto.randomUUID(),
    } as PedidoDoc;
    expect(modifier(borradorAjeno)).toBeNull();
  });

  test("mensajes: a foreign leftover draft never enters the lane", () => {
    const modifier = modificadorDraftsPropios<MensajeDoc>("mensajes", ID);
    const ajeno = {
      id: crypto.randomUUID(),
      fkAutor: OTRO,
      syncOpId: crypto.randomUUID(),
    } as MensajeDoc;
    expect(modifier(ajeno)).toBeNull();
  });

  test("productosSemanales: an item whose parent publication is unknown is skipped conservatively", () => {
    const modifier = modificadorDraftsPropios<ItemSemanalDoc>("productosSemanales", ID);
    const desconocida = {
      id: crypto.randomUUID(),
      fkPublicacion: crypto.randomUUID(),
    } as ItemSemanalDoc;
    expect(modifier(desconocida)).toBeNull();
    const pub = crypto.randomUUID();
    registrarPublicacionesPropias([{ id: pub, fkAgricultor: ID }], ID);
    const propio = { id: crypto.randomUUID(), fkPublicacion: pub } as ItemSemanalDoc;
    expect(modifier(propio)).toBe(propio);
  });
});

describe("aplicarResultados (T4 unified verdict application)", () => {
  type Doc = { id: string };
  const resultado = (
    veredicto: PushResultado<Doc>["veredicto"],
    extra: Partial<PushResultado<Doc>> = {},
  ): PushResultado<Doc> => ({
    operationId: crypto.randomUUID(),
    docId: crypto.randomUUID(),
    veredicto,
    ...extra,
  });

  test("conflicts: only non-aplicada verdicts with server state feed the conflictHandler", () => {
    const aplicada = resultado("aplicada", { estadoServidor: { id: "a" } as never });
    const conflicto = resultado("conflicto", { estadoServidor: { id: "b" } as never });
    const rechazada = resultado("rechazada", { motivo: "x" });
    const conflicts = aplicarResultados<Doc>("mensajes", [aplicada, conflicto, rechazada]);
    expect(conflicts.map((c) => c.id)).toEqual(["b"]);
  });

  test("localidades: every verdict resolves its pending marker; the badge carries the motivo", () => {
    const resueltos: string[] = [];
    const rechazada = resultado("rechazada", { motivo: "La unidad es requerida" });
    aplicarResultados<Doc>("localidades", [resultado("aplicada"), rechazada], {
      resolverPending: (docId) => resueltos.push(docId),
    });
    expect(resueltos).toHaveLength(2);
    expect(getSyncStatus().collections.localidades?.error).toBe(
      "Rechazada: La unidad es requerida",
    );
  });

  test("draft lanes: a parked malformed op keeps the badge when no rechazada overrides it", () => {
    aplicarResultados<Doc>("publicaciones", [resultado("aplicada")], {
      errorApartadas: "Rechazada: documento malformado, operación estacionada localmente (x)",
    });
    expect(getSyncStatus().collections.publicaciones?.error).toBe(
      "Rechazada: documento malformado, operación estacionada localmente (x)",
    );
    // A rechazada verdict overrides the parked error.
    aplicarResultados<Doc>(
      "publicaciones",
      [resultado("rechazada", { motivo: "Ya existe una publicación" })],
      { errorApartadas: "Rechazada: documento malformado" },
    );
    expect(getSyncStatus().collections.publicaciones?.error).toBe(
      "Rechazada: Ya existe una publicación",
    );
  });

  test("pedidos: alVeredicto fires per verdict and the badge error stays pinned to null", () => {
    const veredictos: PushResultado<Doc>["veredicto"][] = [];
    aplicarResultados<Doc>(
      "pedidos",
      [
        resultado("aplicada"),
        resultado("rechazada", { motivo: "Solo el rol Cliente puede enviar pedidos en cola" }),
      ],
      {
        errorSiempreNulo: true,
        alVeredicto: (r) => veredictos.push(r.veredicto),
      },
    );
    expect(veredictos).toEqual(["aplicada", "rechazada"]);
    expect(getSyncStatus().collections.pedidos?.error).toBeNull();
  });
});
