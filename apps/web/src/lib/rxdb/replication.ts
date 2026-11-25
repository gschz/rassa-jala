import { replicateRxCollection } from "rxdb/plugins/replication";
import type {
  RxCollection,
  ReplicationPullHandler,
  ReplicationPushHandler,
  WithDeleted,
} from "rxdb/plugins/core";
import { toast } from "sonner";

import { getServerUrl } from "../server-url";
import { getSession } from "../auth/session";
import type {
  LocalidadDoc,
  MunicipioDoc,
  CategoriaDoc,
  FamiliaDoc,
  MembresiaDoc,
  LimiteCreditoDoc,
  ProductoDoc,
  ImagenDoc,
  PublicacionDoc,
  ItemSemanalDoc,
  PedidoDoc,
  MensajeDoc,
  RassaDatabase,
} from "./database";
import {
  pullBatch,
  pushOperaciones,
  type Coleccion,
  type PushOperacion,
  type PushResultado,
  type SyncCheckpoint,
} from "./sync-client";
import {
  aplicarResultados,
  armarOperacionesPush,
  esRechazoTerminalHttp,
  modificadorDraftsPropios,
  normalizarMensajePush,
  registrarPublicacionesPropias,
} from "./push-ops";
import { patchStatus, resolvePending } from "./sync-status";
import { decideRewind } from "./rewind";
import { completarTombstone, type SchemaView } from "./tombstone";

const PULL_BATCH_SIZE = 50;
const PUSH_BATCH_SIZE = 50;
const RESYNC_INTERVAL_MS = 15_000;

/**
 * Replication wiring for the slice collections (sync doc §14), the P0 Familias
 * scoped collections and the P0 Publicaciones S2 draft push: PULL for all,
 * PUSH only for `localidades` (mechanism demo) and the `publicaciones`/
 * `productosSemanales` drafts (real S2 offline writes). Scoped collections
 * replicate with a per-user checkpoint (§11).
 */

type ReplicationHandle = {
  reSync: () => void;
  cancel: () => Promise<void>;
};

function pullHandler<TDoc>(
  coleccion: Coleccion,
  jsonSchema: SchemaView,
): ReplicationPullHandler<TDoc, SyncCheckpoint> {
  return async (lastPulledCheckpoint, batchSize) => {
    let res = await pullBatch<TDoc & { _deleted?: boolean }>(
      coleccion,
      lastPulledCheckpoint ?? null,
      batchSize,
    );
    // §4.2 rewind: a checkpoint ahead of the server's current outbox head
    // (server DB restore) returns empty batches forever. RxDB only persists a
    // pulled checkpoint alongside documents (an empty batch never persists
    // one), so the handler re-pulls from scratch and returns those docs plus
    // the server checkpoint — RxDB then resumes below the head. Upserts are
    // idempotent and tombstones overwrite, so no local data is deleted.
    if (decideRewind(lastPulledCheckpoint?.seq, res.headSeq)) {
      console.warn(
        `[sync] rewind detected in ${coleccion}: checkpoint ${lastPulledCheckpoint?.seq} > server head ${res.headSeq}; re-pulling from scratch`,
      );
      res = await pullBatch<TDoc & { _deleted?: boolean }>(coleccion, null, batchSize);
    }
    patchStatus(coleccion, {
      error: null,
      lastSyncAt: Date.now(),
      checkpoint: res.checkpoint ? res.checkpoint.seq : null,
    });
    return {
      // The server emits `_deleted` explicitly (sync doc §4.1); default to
      // false when absent. Minimal tombstones (§4.3 — hard deletes AND rows
      // missing server-side) get their schema-required fields filled or the
      // dev-mode ajv write check rejects them and the replication error-loops.
      documents: res.documentos.map(
        ({ _deleted, ...doc }) =>
          completarTombstone(
            { ...doc, _deleted: _deleted === true } as TDoc & { _deleted: boolean },
            jsonSchema,
          ) as WithDeleted<TDoc>,
      ),
      checkpoint: res.checkpoint ?? undefined,
    };
  };
}

// T2 (gap-pass-6): a terminal (4xx) push rejection must NEVER retry — the QA
// loop class (RxDB re-pushed the same rows every 5s on a 400). Parking the
// batch drains the queue rows (the handler resolves without throwing), keeps
// the local docs, and surfaces the reason; the pending markers stay until the
// T3/T4 contract gives drafts a per-doc rejected state.
async function empujarConParada<TDoc>(
  coleccion: Coleccion,
  operaciones: PushOperacion<TDoc>[],
): Promise<{ resultados: PushResultado<TDoc>[] | null }> {
  try {
    return { resultados: await pushOperaciones<TDoc>(coleccion, operaciones) };
  } catch (error) {
    if (!esRechazoTerminalHttp(error)) throw error;
    const motivo = error instanceof Error ? error.message : String(error);
    console.error(
      `[sync] ${coleccion}: push terminally rejected by the server (4xx); batch parked locally, no retry:`,
      motivo,
    );
    patchStatus(coleccion, {
      error: `Rechazada: el servidor rechazó el lote y no se reintentará (${motivo})`,
    });
    return { resultados: null };
  }
}

function pushLocalidadesHandler(): ReplicationPushHandler<LocalidadDoc> {
  return async (rows) => {
    const { operaciones } = armarOperacionesPush<LocalidadDoc>(rows);

    const { resultados } = await empujarConParada<LocalidadDoc>("localidades", operaciones);
    if (!resultados) return [];

    // Any terminal verdict resolves the pending marker: aplicada confirms
    // the write; conflicto/rechazada feed the server-wins conflictHandler.
    // §5.1: return ONLY the conflicted server states; empty array otherwise.
    return aplicarResultados<LocalidadDoc>("localidades", resultados, {
      resolverPending: resolvePending,
    });
  };
}

// S2 draft push (P0 Publicaciones): the operationId is the local write's syncOpId
// (stable between retries, §7). Pending markers for these collections ride on the doc
// itself (syncOpId != null until the confirmed state round-trips via PULL).
//
// T2 (gap-pass-6): `normalizar` may park malformed operations (never on the wire);
// `versionAsumida ≤ 0` (a local draft's version) is sanitized to null — sending 0
// 400s the whole batch forever. See push-ops.ts.
function pushDraftsHandler<TDoc extends { id: string; syncOpId?: string; version: number }>(
  coleccion: Coleccion,
  normalizar?: (operacion: PushOperacion<TDoc>) => PushOperacion<TDoc> | null,
): ReplicationPushHandler<TDoc> {
  return async (rows) => {
    const { operaciones, apartadas } = armarOperacionesPush<TDoc>(rows, normalizar);
    const errorApartadas = apartadas.length
      ? `Rechazada: documento malformado, operación estacionada localmente (${apartadas
          .map((a) => a.docId)
          .join(", ")})`
      : null;
    if (errorApartadas) {
      console.warn(
        `[sync] ${coleccion}: ${apartadas.length} malformed operation(s) parked locally (never sent):`,
        apartadas.map((a) => a.docId),
      );
      patchStatus(coleccion, { error: errorApartadas });
    }
    if (operaciones.length === 0) return [];

    const { resultados } = await empujarConParada<TDoc>(coleccion, operaciones);
    if (!resultados) return [];

    // §5.1: return ONLY the conflicted/rejected server states; empty array otherwise.
    return aplicarResultados<TDoc>(coleccion, resultados, { errorApartadas });
  };
}

// T4 (gap-pass-6): the draft-ownership guard for ALL draft lanes moved to
// push-ops.ts (`DUEÑO_DRAFT_POR_LANE` + `modificadorDraftsPropios`) — the
// publicaciones 403-loop fix was the first instance; a foreign leftover draft
// pushed under the wrong identity would come back with a persisted rechazada
// verdict + tombstone that the server-wins conflictHandler applies (the owner's
// draft is DELETED) and the stored operationId would poison the owner's replay.

// P0 Pedidos — S2 creation-in-queue push (database.md §6.2 `pedidos` row): only the
// offline-created order draft (syncOpId present, `items` attached) travels; the server
// adjudicates and the verdicts surface to the user (rechazada → toast with motivo).
function pushPedidosHandler(): ReplicationPushHandler<PedidoDoc> {
  return async (rows) => {
    const { operaciones } = armarOperacionesPush<PedidoDoc>(rows);

    const { resultados } = await empujarConParada<PedidoDoc>("pedidos", operaciones);
    if (!resultados) return [];

    // The verdicts surface via toasts (exact copy preserved); the badge error
    // stays pinned to null — the toast is this lane's user-facing surface.
    return aplicarResultados<PedidoDoc>("pedidos", resultados, {
      errorSiempreNulo: true,
      alVeredicto: (r) => {
        if (r.veredicto === "rechazada") {
          toast.error(`Pedido rechazado: ${r.motivo ?? "sin motivo del servidor"}`);
        } else if (r.veredicto === "aplicada") {
          toast.success("Pedido confirmado por el servidor");
        }
      },
    });
  };
}

type PushConfig<TDoc> = {
  handler: ReplicationPushHandler<TDoc>;
  // RxDB: a push modifier returning null SKIPS the doc (local write still
  // persists, nothing is sent to the remote) — used by pedidos to keep the
  // optimistic server-truth patch out of the push lane.
  modifier?: (doc: TDoc) => TDoc | null;
};

function startReplication<TDoc>(
  coleccion: Coleccion,
  collection: RxCollection<TDoc>,
  push: PushConfig<TDoc> | undefined,
  sufijoIdentidad = "",
): ReplicationHandle {
  // §2.1: the replicationIdentifier persists checkpoints and resumes after
  // reload; it includes the server URL per the docs' recommendation. Scoped
  // collections append the user id (§11) via sufijoIdentidad.
  const state = replicateRxCollection<TDoc, SyncCheckpoint>({
    replicationIdentifier: `rassajala-slice-${coleccion}${sufijoIdentidad}:${getServerUrl()}`,
    collection,
    deletedField: "_deleted",
    live: true,
    // §10: failed requests retry after this wait; the wait is skipped on
    // offline->online transitions detected via navigator.onLine.
    retryTime: 5_000,
    pull: {
      batchSize: PULL_BATCH_SIZE,
      handler: pullHandler<TDoc>(coleccion, collection.schema.jsonSchema),
    },
    push: push
      ? {
          batchSize: PUSH_BATCH_SIZE,
          handler: push.handler,
          ...(push.modifier ? { modifier: push.modifier } : {}),
        }
      : undefined,
  });
  state.error$.subscribe((error) => {
    patchStatus(coleccion, { error: error.message, syncing: false });
  });
  state.active$.subscribe((active) => {
    patchStatus(coleccion, { syncing: active });
  });
  return {
    reSync: () => state.reSync(),
    cancel: () => state.cancel(),
  };
}

// Scoped collections (P0 Familias): the server filters docs per identity (sync doc §11),
// so the checkpoint key MUST be per user — a shared checkpoint would hide data when the
// account changes on the same browser.
function startScopedReplication<TDoc>(
  coleccion: Coleccion,
  collection: RxCollection<TDoc>,
  idUsuario: string,
  push?: PushConfig<TDoc>,
): ReplicationHandle {
  return startReplication<TDoc>(coleccion, collection, push, `:${idUsuario}@`);
}

export type ReplicationSet = {
  reSyncAll: () => void;
  stop: () => Promise<void>;
};

export function startReplications(db: RassaDatabase): ReplicationSet {
  const idUsuario = getSession().user?.id;

  // T4: the productosSemanales ownership cache bridge — a live query over the
  // LOCAL publicaciones collection limited to the active identity's rows. The
  // initial emission seeds publications confirmed in earlier sessions (the pull
  // resumes from its persisted checkpoint and never re-delivers them); every
  // later pull write re-emits and keeps the cache fresh. Unsubscribed in stop().
  const subPublicaciones = idUsuario
    ? db.publicaciones.find({ selector: { fkAgricultor: idUsuario } }).$.subscribe((docs) =>
        registrarPublicacionesPropias(
          docs.map((doc) => ({ id: doc.id, fkAgricultor: doc.fkAgricultor })),
          idUsuario,
        ),
      )
    : null;

  const handles: ReplicationHandle[] = [
    startReplication<MunicipioDoc>("municipios", db.municipios, undefined),
    startReplication<LocalidadDoc>("localidades", db.localidades, {
      handler: pushLocalidadesHandler(),
    }),
    startReplication<CategoriaDoc>("categorias", db.categorias, undefined),
    // Stage A COL23 (M-18): `unidades` freed — server-fetched (catalogos.unidadesList),
    // no RxDB collection.
    // P0 Productos (Q-19): PULL-only global collections — writes are online tRPC.
    startReplication<ProductoDoc>("productos", db.productos, undefined),
    startReplication<ImagenDoc>("imagenes", db.imagenes, undefined),
    // Scoped PULL-only collections (P0 Familias): started only with an authenticated
    // identity — without a user there is nothing to scope against.
    ...(idUsuario
      ? [
          startScopedReplication<FamiliaDoc>("familias", db.familias, idUsuario),
          startScopedReplication<MembresiaDoc>("membresias", db.membresias, idUsuario),
          startScopedReplication<LimiteCreditoDoc>(
            "limites_credito",
            db.limites_credito,
            idUsuario,
          ),
          // P0 Publicaciones (Q-25): scoped PULL + S2 draft PUSH (borrador docs only).
          // The `itemsSemanales` collection syncs under the server name
          // `productosSemanales`.
          // T4: the modifier keeps ONLY drafts owned by the active identity
          // (push-ops registry) — a leftover foreign draft (previous login,
          // same shared RxDB) must never enter this lane: the server's
          // rechazada+tombstone verdict would delete the owner's draft via the
          // server-wins conflictHandler.
          startScopedReplication<PublicacionDoc>("publicaciones", db.publicaciones, idUsuario, {
            handler: pushDraftsHandler<PublicacionDoc>("publicaciones"),
            modifier: modificadorDraftsPropios<PublicacionDoc>("publicaciones", idUsuario),
          }),
          startScopedReplication<ItemSemanalDoc>(
            "productosSemanales",
            db.itemsSemanales,
            idUsuario,
            {
              handler: pushDraftsHandler<ItemSemanalDoc>("productosSemanales"),
              // T4: indirect ownership (fkPublicacion → publicacion.fkAgricultor)
              // resolved through the live-query cache seeded above; an item whose
              // parent publication is unknown is skipped conservatively.
              modifier: modificadorDraftsPropios<ItemSemanalDoc>("productosSemanales", idUsuario),
            },
          ),
          // P0 Pedidos: scoped PULL + the S2 creation push (order drafts only). Lines ride
          // EMBEDDED in the pedido doc (§6.2 grain; free RxDB 13-collection cap) and the
          // estado catalog stays server-side (estadoNombre is embedded in every doc).
          // The push modifier (soloBorradores) keeps ONLY the offline draft (syncOpId)
          // in the lane: the optimistic server-truth patch after online mutations
          // (parchearPedidoLocal) must not be re-pushed — it would bounce as "en cola
          // no se edita" or re-bump the server version. T4 adds the owner guard: the
          // draft's fkCliente must be the active identity (the wire strips it and the
          // server re-binds the order to the CALLER).
          startScopedReplication<PedidoDoc>("pedidos", db.pedidos, idUsuario, {
            handler: pushPedidosHandler(),
            modifier: modificadorDraftsPropios<PedidoDoc>("pedidos", idUsuario, true),
          }),
          // P1-D Chat (M-18): the ONLY S3 bidirectional collection — offline-queued
          // drafts push (create/edit/leido/soft-delete, verdicts + idempotency) and
          // the scoped PULL delivers the conversation timeline. The generic draft
          // handler fits: operationId rides syncOpId; verdicts surface through the
          // server-wins conflictHandler + the rechazada status line. The T2
          // normalizer keeps unparsable contenido off the wire (blank → null,
          // oversized → parked): a batch-wide 400 would loop forever. T4: the
          // owner guard — every draft carries the creator (fkAutor); the server
          // overwrites it with the caller, so a foreign push would forge
          // authorship.
          startScopedReplication<MensajeDoc>("mensajes", db.mensajes, idUsuario, {
            handler: pushDraftsHandler<MensajeDoc>("mensajes", normalizarMensajePush),
            modifier: modificadorDraftsPropios<MensajeDoc>("mensajes", idUsuario),
          }),
        ]
      : []),
  ];

  const reSyncAll = (): void => {
    for (const handle of handles) handle.reSync();
  };

  // §10: without pull.stream$, server changes are detected by reSync() on an
  // interval, plus window focus/online events.
  window.addEventListener("online", reSyncAll);
  window.addEventListener("focus", reSyncAll);
  const intervalId = window.setInterval(reSyncAll, RESYNC_INTERVAL_MS);

  return {
    reSyncAll,
    stop: async () => {
      window.removeEventListener("online", reSyncAll);
      window.removeEventListener("focus", reSyncAll);
      window.clearInterval(intervalId);
      subPublicaciones?.unsubscribe();
      // §2.1: cancel() is definitive; a later start re-creates the
      // replication with the same replicationIdentifier, which reuses the
      // persisted checkpoints without re-downloading.
      await Promise.all(handles.map((handle) => handle.cancel()));
    },
  };
}
