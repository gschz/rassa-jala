import type { WithDeleted } from "rxdb/plugins/core";

import type { Coleccion, PushOp, PushOperacion, PushResultado } from "./sync-client";
import type { ItemSemanalDoc, PublicacionDoc } from "./database";
import { patchStatus } from "./sync-status";

/**
 * The shared push-lane module (T2 + T4, gap-pass-6).
 *
 * T2 wire-shape guards — root cause of the QA 400-loop: every server push schema
 * types `versionAsumida` as `z.number().int().positive().nullable()`, but a LOCAL
 * draft (never pulled) carries `version: 0` — deleting it rides
 * `assumedMasterState.version = 0` on the wire, the server input parse fails with
 * a WHOLE-BATCH 400 (Bad Request), and RxDB only drains the push queue on a 2xx →
 * the same rows re-pushed forever (masterWrite → pushOperaciones → handler,
 * console full of 400s). The rule: the client never sends an operation the server
 * cannot parse, and never retries a terminal (4xx) rejection.
 *
 * T4 lane contract — draft-ownership protection (data loss, not cosmetic) and the
 * ONE unified post-push verdict application shared by every lane handler.
 *
 * The only value import is sync-status's passive store; everything else is
 * type-only, so the module stays unit-testable outside the browser bundle.
 */

/** The subset of RxDB's replication push row the builders use. */
export type FilaPush<TDoc> = {
  newDocumentState: WithDeleted<TDoc>;
  assumedMasterState?: WithDeleted<TDoc> | null;
};

/** Push op from the RxDB write row (§5.1): delete marker → delete, prior master state → update, else create. */
export function determinarOperacionPush(row: {
  newDocumentState: { _deleted?: boolean };
  assumedMasterState?: unknown;
}): PushOp {
  if (row.newDocumentState._deleted) {
    return "delete";
  }
  if (row.assumedMasterState) {
    return "update";
  }
  return "create";
}

/**
 * Builds the wire operations for a push batch, sanitizing `versionAsumida`:
 * a version ≤ 0 is a local-only draft's marker, semantically "no assumed
 * version" (null) — sending 0 violates every lane's `positive()` schema and
 * 400s the whole batch. `normalizar` may return null to PARK a malformed
 * operation (kept out of the wire, its queue row drains on handler resolve).
 */
export function armarOperacionesPush<
  TDoc extends { id: string; syncOpId?: string; version: number },
>(
  rows: readonly FilaPush<TDoc>[],
  normalizar?: (operacion: PushOperacion<TDoc>) => PushOperacion<TDoc> | null,
): { operaciones: PushOperacion<TDoc>[]; apartadas: PushOperacion<TDoc>[] } {
  const operaciones: PushOperacion<TDoc>[] = [];
  const apartadas: PushOperacion<TDoc>[] = [];
  for (const row of rows) {
    // §7: the operationId is assigned by the local write path (syncOpId) and
    // stays stable between retries. Push rows carry no doc revision, so the
    // (docId, _rev) alternative of §7 is not usable with this RxDB version.
    const base: PushOperacion<TDoc> = {
      operationId: row.newDocumentState.syncOpId ?? crypto.randomUUID(),
      docId: row.newDocumentState.id,
      op: determinarOperacionPush(row),
      nuevoEstado: row.newDocumentState,
      versionAsumida:
        row.assumedMasterState && row.assumedMasterState.version > 0
          ? row.assumedMasterState.version
          : null,
    };
    const operacion = normalizar ? normalizar(base) : base;
    if (operacion) {
      operaciones.push(operacion);
    } else {
      apartadas.push(base);
    }
  }
  return { operaciones, apartadas };
}

// The server schema only parses contenido as null or a 1..2000 string (trimmed
// in-chain); anything else 400s the whole mensajes batch. Blank → null (the
// server then answers a per-op verdict: create → rechazada "obligatorio",
// update/delete adjudicate normally). Oversized → PARKED: user data the server
// would hard-reject is never silently mutated to fit the wire.
const CONTENIDO_MAX = 2000;

export function normalizarMensajePush<TDoc extends { contenido?: string | null }>(
  operacion: PushOperacion<TDoc>,
): PushOperacion<TDoc> | null {
  const contenido = operacion.nuevoEstado.contenido;
  if (typeof contenido !== "string") return operacion;
  const trimmed = contenido.trim();
  if (trimmed.length > CONTENIDO_MAX) return null;
  return {
    ...operacion,
    nuevoEstado: {
      ...operacion.nuevoEstado,
      contenido: trimmed === "" ? null : trimmed,
    } as WithDeleted<TDoc>,
  };
}

/**
 * A 4xx push response is a TERMINAL rejection (bad input, forbidden, not
 * found): RxDB would retry it forever (retryTime 5s) — the QA loop class.
 * 401 is excluded (auth refresh may make a retry succeed); network errors and
 * 5xx have no `data.httpStatus` and stay retryable.
 */
export function esRechazoTerminalHttp(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const data = (error as { data?: { httpStatus?: unknown; code?: unknown } }).data;
  const httpStatus = data?.httpStatus;
  if (typeof httpStatus === "number") {
    return httpStatus >= 400 && httpStatus < 500 && httpStatus !== 401;
  }
  // Defensive: some client error paths surface the code without a numeric status.
  return data?.code === "BAD_REQUEST" || data?.code === "FORBIDDEN" || data?.code === "NOT_FOUND";
}

// ---------------------------------------------------------------------------
// Draft-ownership guard (T4, gap-pass-6) — DATA PROTECTION, not cosmetic.
//
// The browser shares ONE RxDB across logins: a leftover `syncOpId` draft written
// by a previous user re-enters the current identity's push lane (a fresh
// replicationIdentifier re-emits it, §11). Pushing it under the wrong identity
// makes the server answer a persisted `rechazada` verdict whose tombstone
// `estadoServidor` feeds the server-wins conflictHandler — the owner's local
// draft gets DELETED, and the verdict stored by operationId poisons the replay.
// Every draft lane therefore pushes ONLY docs owned by the active identity
// (strict: a draft with no known owner never pushes).
// ---------------------------------------------------------------------------

/**
 * The owner-field surface every guarded lane doc exposes (structural, so this
 * module stays decoupled from the concrete doc types at the predicate level).
 */
export type EstructuraDocLane = {
  id?: string;
  syncOpId?: string;
  fkAgricultor?: string | null;
  fkCliente?: string | null;
  fkAutor?: string | null;
  fkPublicacion?: string | null;
};

// productosSemanales: ownership is INDIRECT (fkPublicacion → publicacion.fkAgricultor)
// and RxDB push modifiers are SYNCHRONOUS — there is no await-able owner lookup. A
// module-level Set of the active identity's publication ids bridges the gap: it is
// fed by a live query over the LOCAL publicaciones collection (only rows with
// fkAgricultor = active user — see startReplications). The initial emission seeds
// publications confirmed in earlier sessions (the pull resumes from its persisted
// checkpoint and would never re-deliver them); every later pull write keeps the
// cache fresh. Unknown publication or empty set → NOT owned (conservative skip;
// the reSync cycle retries once the cache is filled — an item whose parent
// publication is unknown has no legitimate push path).
const publicacionesPropias = new Set<string>();

export function registrarPublicacionesPropias(
  docs: ReadonlyArray<{ id: string; fkAgricultor: string | null }>,
  idUsuario: string,
): void {
  for (const doc of docs) {
    if (doc.fkAgricultor === idUsuario) publicacionesPropias.add(doc.id);
  }
}

export function esProductoSemanalPropio(doc: Pick<ItemSemanalDoc, "fkPublicacion">): boolean {
  return publicacionesPropias.has(doc.fkPublicacion);
}

/**
 * The per-lane draft-ownership registry (T4). Direct-owner lanes compare the
 * creator field the draft write stamps (catalogo.tsx `checkoutOffline` →
 * fkCliente, chat.tsx → fkAutor, publicaciones.tsx → fkAgricultor): the wire
 * strips/re-binds those fields server-side, so a foreign push would adjudicate
 * the caller's row from the owner's data. `localidades` is intentionally
 * ABSENT: its writes are online tRPC (`catalogos.localidades*`) and no code
 * path creates a localidad draft — the push lane is the §5.1 mechanism demo,
 * so an owner filter there would be dead code.
 */
export const DUEÑO_DRAFT_POR_LANE: Readonly<
  Record<
    "publicaciones" | "pedidos" | "mensajes" | "productosSemanales",
    (doc: EstructuraDocLane, idUsuario: string) => boolean
  >
> = {
  publicaciones: (doc, idUsuario) => doc.fkAgricultor === idUsuario,
  pedidos: (doc, idUsuario) => doc.fkCliente === idUsuario,
  mensajes: (doc, idUsuario) => doc.fkAutor === idUsuario,
  productosSemanales: (doc) => publicacionesPropias.has(doc.fkPublicacion ?? ""),
};

export type LaneConDueño = keyof typeof DUEÑO_DRAFT_POR_LANE;

export type { PushResultado };

/**
 * Strict equality: a draft with no known owner never pushes. Moved from
 * replication.ts (T4) — the first ownership guard, kept as the named face of
 * the registry entry for the publicaciones lane.
 */
export function esDraftPropioPublicaciones(
  doc: Pick<PublicacionDoc, "fkAgricultor">,
  idUsuario: string,
): boolean {
  return DUEÑO_DRAFT_POR_LANE.publicaciones(doc, idUsuario);
}

// One console.info per foreign draft per page load: the modifier re-runs on
// every push round while the stale draft stays parked (its owner's lane only
// comes back under the owner's login).
const avisadosDraftAjenos = new Set<string>();

/**
 * The shared push modifier (T4): keeps ONLY docs owned by the active identity —
 * a null return SKIPS the doc (the local write still persists, nothing is sent
 * to the remote). With `soloBorradores` (pedidos) a non-draft doc is skipped
 * first: the optimistic server-truth patch (parchearPedidoLocal) must never
 * re-enter the lane.
 */
export function modificadorDraftsPropios<TDoc extends EstructuraDocLane>(
  coleccion: LaneConDueño,
  idUsuario: string,
  soloBorradores = false,
): (doc: TDoc) => TDoc | null {
  const esPropio = DUEÑO_DRAFT_POR_LANE[coleccion];
  return (doc) => {
    if (soloBorradores && !doc.syncOpId) return null;
    if (esPropio(doc, idUsuario)) return doc;
    if (doc.syncOpId && !avisadosDraftAjenos.has(`${coleccion}:${doc.id}`)) {
      avisadosDraftAjenos.add(`${coleccion}:${doc.id}`);
      console.info(
        `[sync] ${coleccion}: draft ${doc.id} kept out of this push lane (not owned by the active user, or for productosSemanales its parent publication is not in the ownership cache)`,
      );
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Unified verdict application (T4, gap-pass-6)
// ---------------------------------------------------------------------------

function formatearErrorRechazo(rechazada?: { motivo?: string | null } | null): string | null {
  if (!rechazada) {
    return null;
  }
  return rechazada.motivo
    ? `Rechazada: ${rechazada.motivo}`
    : "Operación rechazada por el servidor";
}

export type OpcionesAplicarResultados<TDoc> = {
  /** localidades: every terminal verdict resolves its push-pending marker. */
  resolverPending?: (docId: string) => void;
  /** pedidos: called once per verdict (the exact toast copy lives in the wiring — sonner stays out of this module). */
  alVeredicto?: (resultado: PushResultado<TDoc>) => void;
  /** Draft lanes: a parked malformed op keeps the badge when no rechazada overrides it. */
  errorApartadas?: string | null;
  /** pedidos: verdicts surface via toasts — the badge error stays pinned to null (existing lane behavior). */
  errorSiempreNulo?: boolean;
};

/**
 * The ONE post-push verdict loop every lane handler shares (§5.1): collects the
 * conflicted/rejected server states for the server-wins conflictHandler, fires
 * the lane's per-verdict side effects, and patches the collection's sync status
 * (lastSyncAt + the badge error per lane policy). Returns the conflicts — empty
 * when every operation was `aplicada`.
 */
export function aplicarResultados<TDoc>(
  coleccion: Coleccion,
  resultados: readonly PushResultado<TDoc>[],
  opciones: OpcionesAplicarResultados<TDoc> = {},
): WithDeleted<TDoc>[] {
  const conflicts: WithDeleted<TDoc>[] = [];
  for (const resultado of resultados) {
    opciones.resolverPending?.(resultado.docId);
    if (resultado.estadoServidor && resultado.veredicto !== "aplicada") {
      conflicts.push(resultado.estadoServidor as WithDeleted<TDoc>);
    }
    opciones.alVeredicto?.(resultado);
  }
  const rechazada = resultados.find((r) => r.veredicto === "rechazada");
  patchStatus(coleccion, {
    lastSyncAt: Date.now(),
    error: opciones.errorSiempreNulo
      ? null
      : (formatearErrorRechazo(rechazada) ?? opciones.errorApartadas ?? null),
  });
  return conflicts;
}
