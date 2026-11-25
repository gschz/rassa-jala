import type { RassaDatabase } from "./database";

/**
 * C2 (gap-pass-5): local resolution of chat-message deletes whose server row does
 * not exist. Two orphan kinds:
 * - Draft never confirmed (syncOpId present, no PULL round-trip yet): it exists
 *   ONLY locally. `remove()` is the lane's own mechanism — the push carries the
 *   delete op, and a server that never saw the row answers rechazada + tombstone,
 *   which settles through the server-wins conflictHandler (one rejected push, no
 *   retry loop). The online chat.eliminar lane would answer NOT_FOUND forever.
 * - Ghost: a doc whose server row is gone (lost/rejected create, server DB
 *   restore). chat.eliminar answers NOT_FOUND on every retry and the PULL never
 *   tombstones a row it does not know — the only cleanup is local removal.
 * Server-confirmed docs keep the online chat.eliminar lane (untouched).
 */

/** Removes the message doc when it is a local-only draft (syncOpId present). */
export async function eliminarBorradorLocal(db: RassaDatabase, id: string): Promise<boolean> {
  const doc = await db.mensajes.findOne(id).exec();
  if (doc?.syncOpId == null) return false;
  await doc.remove();
  return true;
}

/** Removes the message doc regardless of its sync state (ghost compensation). */
export async function eliminarMensajeFantasma(db: RassaDatabase, id: string): Promise<boolean> {
  const doc = await db.mensajes.findOne(id).exec();
  if (!doc) return false;
  await doc.remove();
  return true;
}
