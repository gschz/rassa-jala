import type { RassaDatabase } from "./database";

/**
 * Optimistic local patch after an ONLINE pedido mutation (roadmap gap 2 ①, QA
 * F17-r2): the server DTO returned by pedidos.claimar/cancelar/pedidoPresencial
 * and pagos.registrarPago/marcarEntregado (`pedido` field) mirrors the server
 * truth — the doc flips immediately without waiting for the next PULL.
 *
 * Mechanism: `incrementalUpsert` is the RxDB-correct write (merge by primary
 * key; never `_rev` surgery). Two invariants keep it from fighting the
 * replication:
 * - The `pedidos` push modifier skips docs without `syncOpId`
 *   (replication.ts), so this write never re-enters the push lane.
 * - A later PULL delivers the SAME values (server truth == patched truth);
 *   `serverWinsConflictHandler`'s `isEqual` sees no change — no conflict loop.
 */
export type PedidoServidor = {
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
  // pedidos.ts DTO carries fkPedido/version per line; the client doc embeds the
  // lean inline shape — normalized here so the patch matches what PULL writes.
  detalles?: Array<{
    id: string;
    fkProductoSemanal: string;
    nombreProducto: string;
    cantidad: number;
    precioUnitario: string;
    importe: string;
  }>;
};

/** Server DTO → the client PedidoDoc shape (also used to seed e2e local docs). */
export function aDocPedidoLocal(servidor: PedidoServidor): PedidoServidor & { _deleted: boolean } {
  // Build the patch without undefined keys: an explicit `detalles: undefined`
  // would WIPE a pulled doc's embedded lines on merge. The server DTO may carry
  // fkPedido/version per line; the client doc embeds the lean inline shape —
  // stripping keeps the patch field-identical to what the next PULL writes.
  const doc: Record<string, unknown> = { ...servidor };
  if (servidor.detalles) {
    doc.detalles = servidor.detalles.map((d) => ({
      id: d.id,
      fkProductoSemanal: d.fkProductoSemanal,
      nombreProducto: d.nombreProducto,
      cantidad: d.cantidad,
      precioUnitario: d.precioUnitario,
      importe: d.importe,
    }));
  }
  // Lifecycle value: a live order row is never a tombstone (§6.3.5).
  doc._deleted = false;
  return doc as PedidoServidor & { _deleted: boolean };
}

export async function parchearPedidoLocal(
  db: RassaDatabase,
  servidor: PedidoServidor,
): Promise<void> {
  await db.pedidos.incrementalUpsert(aDocPedidoLocal(servidor));
}
