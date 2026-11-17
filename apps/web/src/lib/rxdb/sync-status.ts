import { useSyncExternalStore } from "react";

import type { Coleccion } from "./sync-client";

/**
 * Minimal external store for sync indicators (sync doc §6 UX: connectivity
 * and per-collection sync status; pending operations are never shown as
 * confirmed). Plain React bindings — no new dependencies.
 */

export type ColeccionSyncStatus = {
  syncing: boolean;
  error: string | null;
  lastSyncAt: number | null;
  checkpoint: number | null;
};

export type SyncStatusState = {
  collections: Record<Coleccion, ColeccionSyncStatus>;
  /** Localidades pushed but not yet confirmed by a sync.push verdict. */
  pendingLocalidadIds: readonly string[];
};

const EMPTY_STATUS: ColeccionSyncStatus = {
  syncing: false,
  error: null,
  lastSyncAt: null,
  checkpoint: null,
};

const COLECCIONES: readonly Coleccion[] = ["municipios", "localidades", "categorias", "unidades"];

let state: SyncStatusState = {
  collections: Object.fromEntries(COLECCIONES.map((c) => [c, EMPTY_STATUS])) as Record<
    Coleccion,
    ColeccionSyncStatus
  >,
  pendingLocalidadIds: [],
};

const listeners = new Set<() => void>();

function setState(next: SyncStatusState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeSyncStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSyncStatus(): SyncStatusState {
  return state;
}

export function useSyncStatus(): SyncStatusState {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus);
}

export function patchStatus(coleccion: Coleccion, patch: Partial<ColeccionSyncStatus>): void {
  const merged = { ...state.collections[coleccion], ...patch };
  setState({
    ...state,
    collections: { ...state.collections, [coleccion]: merged },
  });
}

/** Marks a localidad as awaiting server confirmation (before its push). */
export function trackPending(docId: string): void {
  if (state.pendingLocalidadIds.includes(docId)) return;
  setState({
    ...state,
    pendingLocalidadIds: [...state.pendingLocalidadIds, docId],
  });
}

/** A sync.push verdict arrived for the doc: it is no longer unconfirmed. */
export function resolvePending(docId: string): void {
  if (!state.pendingLocalidadIds.includes(docId)) return;
  setState({
    ...state,
    pendingLocalidadIds: state.pendingLocalidadIds.filter((id) => id !== docId),
  });
}
