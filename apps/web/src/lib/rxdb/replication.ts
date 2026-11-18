import { replicateRxCollection } from "rxdb/plugins/replication";
import type {
  RxCollection,
  ReplicationPullHandler,
  ReplicationPushHandler,
  WithDeleted,
} from "rxdb/plugins/core";
import { toast } from "sonner";

import { ENV } from "../../env";
import { getSession } from "../auth/session";
import type {
  LocalidadDoc,
  MunicipioDoc,
  CategoriaDoc,
  UnidadDoc,
  FamiliaDoc,
  MembresiaDoc,
  LimiteCreditoDoc,
  ProductoDoc,
  ImagenDoc,
  PublicacionDoc,
  ItemSemanalDoc,
  PedidoDoc,
  RassaDatabase,
} from "./database";
import {
  pullBatch,
  pushOperaciones,
  type Coleccion,
  type PushOperacion,
  type SyncCheckpoint,
} from "./sync-client";
import { patchStatus, resolvePending } from "./sync-status";

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

function pullHandler<TDoc>(coleccion: Coleccion): ReplicationPullHandler<TDoc, SyncCheckpoint> {
  return async (lastPulledCheckpoint, batchSize) => {
    const res = await pullBatch<TDoc & { _deleted?: boolean }>(
      coleccion,
      lastPulledCheckpoint ?? null,
      batchSize,
    );
    patchStatus(coleccion, {
      error: null,
      lastSyncAt: Date.now(),
      checkpoint: res.checkpoint ? res.checkpoint.seq : null,
    });
    return {
      // The server emits `_deleted` explicitly (sync doc §4.1); default to
      // false when absent.
      documents: res.documentos.map(
        ({ _deleted, ...doc }) => ({ ...doc, _deleted: _deleted === true }) as WithDeleted<TDoc>,
      ),
      checkpoint: res.checkpoint ?? undefined,
    };
  };
}

function pushLocalidadesHandler(): ReplicationPushHandler<LocalidadDoc> {
  return async (rows) => {
    const operaciones: PushOperacion<LocalidadDoc>[] = rows.map((row) => ({
      // §7: the operationId is assigned by the local write path and stays
      // stable between retries. Push rows carry no doc revision, so the
      // (docId, _rev) alternative of §7 is not usable with this RxDB version.
      operationId: row.newDocumentState.syncOpId ?? crypto.randomUUID(),
      docId: row.newDocumentState.id,
      op: row.newDocumentState._deleted ? "delete" : row.assumedMasterState ? "update" : "create",
      nuevoEstado: row.newDocumentState,
      versionAsumida: row.assumedMasterState ? row.assumedMasterState.version : null,
    }));

    const resultados = await pushOperaciones<LocalidadDoc>("localidades", operaciones);

    const conflicts: WithDeleted<LocalidadDoc>[] = [];
    for (const resultado of resultados) {
      // Any terminal verdict resolves the pending marker: aplicada confirms
      // the write; conflicto/rechazada feed the server-wins conflictHandler.
      resolvePending(resultado.docId);
      if (resultado.estadoServidor && resultado.veredicto !== "aplicada") {
        conflicts.push(resultado.estadoServidor);
      }
    }
    const rechazada = resultados.find((r) => r.veredicto === "rechazada");
    patchStatus("localidades", {
      lastSyncAt: Date.now(),
      error: rechazada
        ? rechazada.motivo
          ? `Rechazada: ${rechazada.motivo}`
          : "Operación rechazada por el servidor"
        : null,
    });
    // §5.1: return ONLY the conflicted server states; empty array otherwise.
    return conflicts;
  };
}

// S2 draft push (P0 Publicaciones): the operationId is the local write's syncOpId
// (stable between retries, §7). Pending markers for these collections ride on the doc
// itself (syncOpId != null until the confirmed state round-trips via PULL).
function pushDraftsHandler<TDoc extends { id: string; syncOpId?: string; version: number }>(
  coleccion: Coleccion,
): ReplicationPushHandler<TDoc> {
  return async (rows) => {
    const operaciones: PushOperacion<TDoc>[] = rows.map((row) => ({
      operationId: row.newDocumentState.syncOpId ?? crypto.randomUUID(),
      docId: row.newDocumentState.id,
      op: row.newDocumentState._deleted ? "delete" : row.assumedMasterState ? "update" : "create",
      nuevoEstado: row.newDocumentState,
      versionAsumida: row.assumedMasterState ? row.assumedMasterState.version : null,
    }));

    const resultados = await pushOperaciones<TDoc>(coleccion, operaciones);

    const conflicts: WithDeleted<TDoc>[] = [];
    for (const resultado of resultados) {
      if (resultado.estadoServidor && resultado.veredicto !== "aplicada") {
        conflicts.push(resultado.estadoServidor as WithDeleted<TDoc>);
      }
    }
    const rechazada = resultados.find((r) => r.veredicto === "rechazada");
    patchStatus(coleccion, {
      lastSyncAt: Date.now(),
      error: rechazada
        ? rechazada.motivo
          ? `Rechazada: ${rechazada.motivo}`
          : "Operación rechazada por el servidor"
        : null,
    });
    // §5.1: return ONLY the conflicted/rejected server states; empty array otherwise.
    return conflicts;
  };
}

// P0 Pedidos — S2 creation-in-queue push (database.md §6.2 `pedidos` row): only the
// offline-created order draft (syncOpId present, `items` attached) travels; the server
// adjudicates and the verdicts surface to the user (rechazada → toast with motivo).
function pushPedidosHandler(): ReplicationPushHandler<PedidoDoc> {
  return async (rows) => {
    const operaciones: PushOperacion<PedidoDoc>[] = rows.map((row) => ({
      operationId: row.newDocumentState.syncOpId ?? crypto.randomUUID(),
      docId: row.newDocumentState.id,
      op: row.newDocumentState._deleted ? "delete" : row.assumedMasterState ? "update" : "create",
      nuevoEstado: row.newDocumentState,
      versionAsumida: row.assumedMasterState ? row.assumedMasterState.version : null,
    }));

    const resultados = await pushOperaciones<PedidoDoc>("pedidos", operaciones);

    const conflicts: WithDeleted<PedidoDoc>[] = [];
    for (const resultado of resultados) {
      if (resultado.estadoServidor && resultado.veredicto !== "aplicada") {
        conflicts.push(resultado.estadoServidor as WithDeleted<PedidoDoc>);
      }
      if (resultado.veredicto === "rechazada") {
        toast.error(`Pedido rechazado: ${resultado.motivo ?? "sin motivo del servidor"}`);
      } else if (resultado.veredicto === "aplicada") {
        toast.success("Pedido confirmado por el servidor");
      }
    }
    patchStatus("pedidos", {
      lastSyncAt: Date.now(),
      error: null,
    });
    return conflicts;
  };
}

function startReplication<TDoc>(
  coleccion: Coleccion,
  collection: RxCollection<TDoc>,
  push: ReplicationPushHandler<TDoc> | undefined,
  sufijoIdentidad = "",
): ReplicationHandle {
  // §2.1: the replicationIdentifier persists checkpoints and resumes after
  // reload; it includes the server URL per the docs' recommendation. Scoped
  // collections append the user id (§11) via sufijoIdentidad.
  const state = replicateRxCollection<TDoc, SyncCheckpoint>({
    replicationIdentifier: `rassajala-slice-${coleccion}${sufijoIdentidad}:${ENV.VITE_SERVER_URL}`,
    collection,
    deletedField: "_deleted",
    live: true,
    // §10: failed requests retry after this wait; the wait is skipped on
    // offline->online transitions detected via navigator.onLine.
    retryTime: 5_000,
    pull: { batchSize: PULL_BATCH_SIZE, handler: pullHandler<TDoc>(coleccion) },
    push: push ? { batchSize: PUSH_BATCH_SIZE, handler: push } : undefined,
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
  push?: ReplicationPushHandler<TDoc>,
): ReplicationHandle {
  return startReplication<TDoc>(coleccion, collection, push, `:${idUsuario}@`);
}

export type ReplicationSet = {
  reSyncAll: () => void;
  stop: () => Promise<void>;
};

export function startReplications(db: RassaDatabase): ReplicationSet {
  const idUsuario = getSession().user?.id;
  const handles: ReplicationHandle[] = [
    startReplication<MunicipioDoc>("municipios", db.municipios, undefined),
    startReplication<LocalidadDoc>("localidades", db.localidades, pushLocalidadesHandler()),
    startReplication<CategoriaDoc>("categorias", db.categorias, undefined),
    startReplication<UnidadDoc>("unidades", db.unidades, undefined),
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
          startScopedReplication<PublicacionDoc>(
            "publicaciones",
            db.publicaciones,
            idUsuario,
            pushDraftsHandler<PublicacionDoc>("publicaciones"),
          ),
          startScopedReplication<ItemSemanalDoc>(
            "productosSemanales",
            db.itemsSemanales,
            idUsuario,
            pushDraftsHandler<ItemSemanalDoc>("productosSemanales"),
          ),
          // P0 Pedidos: scoped PULL + the S2 creation push (order drafts only). Lines ride
          // EMBEDDED in the pedido doc (§6.2 grain; free RxDB 13-collection cap) and the
          // estado catalog stays server-side (estadoNombre is embedded in every doc).
          startScopedReplication<PedidoDoc>("pedidos", db.pedidos, idUsuario, pushPedidosHandler()),
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
      // §2.1: cancel() is definitive; a later start re-creates the
      // replication with the same replicationIdentifier, which reuses the
      // persisted checkpoints without re-downloading.
      await Promise.all(handles.map((handle) => handle.cancel()));
    },
  };
}
