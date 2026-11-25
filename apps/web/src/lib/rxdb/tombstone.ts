// Structural view of a collection's JSON schema (a real RxJsonSchema satisfies
// it; keeps this module dependency-free so headless tests can import it).
export type SchemaView = {
  readonly required?: readonly string[];
  readonly properties?: Readonly<
    Record<string, { readonly type?: string | readonly string[] } | undefined>
  >;
};

/**
 * Server tombstones are minimal — `{ id, _deleted: true }` (synchronization.md
 * §4.3: outbox `operacion='delete'` OR a source row that no longer exists both
 * resolve to a `_deleted` doc; for orphan rows the server has no row data to
 * send). RxDB keeps deleted documents with all their fields in storage, and the
 * dev-mode storage wrapper (DVM1) validates every fork write against the
 * collection schema: a minimal tombstone fails the `required` list, the
 * downstream bulkWrite rejects the row with a 422, the replication throws
 * RC_PULL into `error$` and the sync badge error-loops ("Error de
 * sincronización en: imagenes" — the checkpoint never persists for that batch).
 *
 * Fill the missing required fields with type-appropriate neutrals so the
 * tombstone passes validation for EVERY collection at once (one shared
 * mechanism in the pull handler, no per-collection patches). The doc stays
 * `_deleted: true` (findOne filters it, no UI surface) and the pulled
 * checkpoint persists because the write succeeds.
 */
export function completarTombstone<TDoc>(
  doc: TDoc & { _deleted: boolean },
  schema: SchemaView,
): TDoc & { _deleted: boolean } {
  if (!doc._deleted) return doc;
  // RxDB-internal fields (`_rev`/`_meta`/`_attachments`) may be required in the
  // collection's final jsonSchema, but they are NOT app data: core fills them on
  // the document write, and the replication meta write stores docData verbatim —
  // a wrong-typed filler (`_attachments: ""`) fails that meta schema (422 →
  // RC_PULL loop). Skip them; only app-level fields get neutrals.
  const requeridos = (schema.required ?? []).filter((campo) => !campo.startsWith("_"));
  if (requeridos.every((campo) => doc[campo as keyof TDoc] !== undefined)) return doc;
  const completo: Record<string, unknown> = { ...doc };
  for (const campo of requeridos) {
    if (doc[campo as keyof TDoc] !== undefined) continue;
    const tipos = schema.properties?.[campo]?.type;
    const lista = tipos == null ? [] : Array.isArray(tipos) ? tipos : [tipos];
    completo[campo] = lista.includes("null")
      ? null
      : lista.includes("boolean")
        ? false
        : lista.includes("integer") || lista.includes("number")
          ? 0
          : "";
  }
  return completo as TDoc & { _deleted: boolean };
}
