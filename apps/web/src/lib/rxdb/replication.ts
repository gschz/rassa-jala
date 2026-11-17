import { replicateRxCollection } from "rxdb/plugins/replication";
import type {
  RxCollection,
  ReplicationPullHandler,
  ReplicationPushHandler,
  WithDeleted,
} from "rxdb/plugins/core";

import { ENV } from "../../env";
import type {
  LocalidadDoc,
  MunicipioDoc,
  CategoriaDoc,
  UnidadDoc,
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
 * Replication wiring for the slice collections (sync doc §14): PULL for all
 * four (S1 cache-first), PUSH only for `localidades` (mechanism demo).
 */

type ReplicationHandle = {
  reSync: () => void;
  cancel: () => Promise<void>;
};

function pullHandler<TDoc>(
  coleccion: Coleccion,
): ReplicationPullHandler<TDoc, SyncCheckpoint> {
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
        ({ _deleted, ...doc }) =>
          ({ ...doc, _deleted: _deleted === true }) as WithDeleted<TDoc>,
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
      op: row.newDocumentState._deleted
        ? "delete"
        : row.assumedMasterState
          ? "update"
          : "create",
      nuevoEstado: row.newDocumentState,
      versionAsumida: row.assumedMasterState
        ? row.assumedMasterState.version
        : null,
    }));

    const resultados = await pushOperaciones<LocalidadDoc>(
      "localidades",
      operaciones,
    );

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

function startReplication<TDoc>(
  coleccion: Coleccion,
  collection: RxCollection<TDoc>,
  push: ReplicationPushHandler<TDoc> | undefined,
): ReplicationHandle {
  // §2.1: the replicationIdentifier persists checkpoints and resumes after
  // reload; it includes the server URL per the docs' recommendation.
  const state = replicateRxCollection<TDoc, SyncCheckpoint>({
    replicationIdentifier: `rassajala-slice-${coleccion}:${ENV.VITE_SERVER_URL}`,
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

export type ReplicationSet = {
  reSyncAll: () => void;
  stop: () => Promise<void>;
};

export function startReplications(db: RassaDatabase): ReplicationSet {
  const handles: ReplicationHandle[] = [
    startReplication<MunicipioDoc>("municipios", db.municipios, undefined),
    startReplication<LocalidadDoc>(
      "localidades",
      db.localidades,
      pushLocalidadesHandler(),
    ),
    startReplication<CategoriaDoc>("categorias", db.categorias, undefined),
    startReplication<UnidadDoc>("unidades", db.unidades, undefined),
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
