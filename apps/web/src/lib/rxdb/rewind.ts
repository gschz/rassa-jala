/**
 * PULL rewind decision (sync doc §4.2): every pull response carries the
 * server's CURRENT outbox head. A checkpoint STRICTLY ahead of that head means
 * the server outbox was reset/restored and this checkpoint returns empty
 * batches forever.
 *
 * `checkpointSeq <= headSeq` is NEVER a rewind: the §4.2 gap window holds rows
 * below the head on purpose, and the server never delivers future seqs. No
 * tolerance parameter on purpose — both values come from the same bigserial
 * (`sync_cambio.id`), there is no clock or skew to absorb.
 */
export function decideRewind(
  checkpointSeq: number | null | undefined,
  headSeq: number | null | undefined,
): boolean {
  // Missing head (older server) or initial pull: nothing ahead, never rewind.
  if (headSeq == null || checkpointSeq == null) return false;
  return checkpointSeq > headSeq;
}
