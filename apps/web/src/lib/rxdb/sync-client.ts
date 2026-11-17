import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import type { WithDeleted } from "rxdb/plugins/core";

import { ENV } from "../../env";
import { authFetch } from "../auth/http";

/**
 * tRPC transport for the replication handlers.
 *
 * The sync procedures are addressed by path string with the exact shapes of
 * docs/synchronization.md §3.1/§4.1/§5.1 (the contract) instead of the typed
 * AppRouter proxy: the server implements them in parallel, so this module must
 * compile against the DOC, not against the server's current code state.
 *
 * P0 auth: replication requests are authenticated (Bearer access token + cookies via
 * authFetch; the server binds actor/fk_usuario to the authenticated identity).
 */
const syncClient = createTRPCUntypedClient<AnyRouter>({
  links: [
    httpBatchLink({
      url: `${ENV.VITE_SERVER_URL.replace(/\/$/, "")}/trpc`,
      fetch: authFetch,
    }),
  ],
});

export type SyncCheckpoint = { seq: number };

const COLECCIONES = ["municipios", "localidades", "categorias", "unidades"] as const;
export type Coleccion = (typeof COLECCIONES)[number];

/** sync.{coleccion}.pull — sync doc §3.1/§4.1 (one procedure per collection). */
export async function pullBatch<TDoc>(
  coleccion: Coleccion,
  checkpoint: SyncCheckpoint | null,
  limit: number,
): Promise<{ documentos: TDoc[]; checkpoint: SyncCheckpoint | null }> {
  // reconcile: per-collection procedure paths + server input key is `limite` (not `limit`).
  return (await syncClient.query(`sync.${coleccion}.pull`, {
    coleccion,
    checkpoint,
    limite: limit,
  })) as {
    documentos: TDoc[];
    checkpoint: SyncCheckpoint | null;
  };
}

export type PushOp = "create" | "update" | "delete";

export type PushOperacion<TDoc> = {
  operationId: string;
  docId: string;
  op: PushOp;
  nuevoEstado: WithDeleted<TDoc>;
  versionAsumida: number | null;
};

export type Veredicto = "aplicada" | "conflicto" | "rechazada";

export type PushResultado<TDoc> = {
  operationId: string;
  docId: string;
  veredicto: Veredicto;
  motivo?: string;
  estadoServidor?: WithDeleted<TDoc>;
};

/** sync.{coleccion}.push — sync doc §3.1/§5.1. Returns the per-document verdicts. */
export async function pushOperaciones<TDoc>(
  coleccion: Coleccion,
  operaciones: PushOperacion<TDoc>[],
): Promise<PushResultado<TDoc>[]> {
  // reconcile: server registers one push procedure per collection (slice: sync.localidades.push).
  const res = (await syncClient.mutation(`sync.${coleccion}.push`, {
    coleccion,
    operaciones,
  })) as { resultados: PushResultado<TDoc>[] };
  return res.resultados;
}
