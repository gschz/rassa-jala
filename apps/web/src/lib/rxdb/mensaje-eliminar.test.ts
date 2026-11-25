import { beforeAll, describe, expect, test } from "bun:test";
import { createRxDatabase, type RxDatabase } from "rxdb/plugins/core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import { collectionCreators, type MensajeDoc, type RassaCollections } from "./database";
import { eliminarBorradorLocal, eliminarMensajeFantasma } from "./mensaje-eliminar";

const docMensaje = (extra: Partial<MensajeDoc> = {}): MensajeDoc => ({
  id: crypto.randomUUID(),
  fkConversacion: crypto.randomUUID(),
  fkAutor: crypto.randomUUID(),
  autorNombre: null,
  contenido: "Hola.",
  tipo: "texto",
  archivoUrl: null,
  leido: false,
  editado: false,
  estado: true,
  version: 0,
  creadoEn: new Date().toISOString(),
  actualizadoEn: new Date().toISOString(),
  ...extra,
});

describe("mensaje-eliminar (C2 orphan lifecycle)", () => {
  let db: RxDatabase<RassaCollections>;

  beforeAll(async () => {
    const created = await createRxDatabase<RassaCollections>({
      name: `test-mensaje-eliminar-${crypto.randomUUID()}`,
      storage: getRxStorageMemory(),
    });
    await created.addCollections(collectionCreators);
    db = created;
  });

  test("draft orphan (syncOpId): eliminarBorradorLocal removes the doc and reports true", async () => {
    const doc = docMensaje({ syncOpId: crypto.randomUUID() });
    await db.mensajes.insert(doc);
    expect(await eliminarBorradorLocal(db, doc.id)).toBe(true);
    expect(await db.mensajes.findOne(doc.id).exec()).toBeNull();
  });

  test("server-confirmed doc (no syncOpId): decision keeps it for the online lane", async () => {
    const doc = docMensaje();
    await db.mensajes.insert(doc);
    // The decision must NOT remove it — chat.eliminar (tRPC) owns this doc.
    expect(await eliminarBorradorLocal(db, doc.id)).toBe(false);
    expect(await db.mensajes.findOne(doc.id).exec()).not.toBeNull();
    // ...and the ghost compensation removes it on a NOT_FOUND answer.
    expect(await eliminarMensajeFantasma(db, doc.id)).toBe(true);
    expect(await db.mensajes.findOne(doc.id).exec()).toBeNull();
  });

  test("missing doc: both helpers report false (idempotent, no throw)", async () => {
    const id = crypto.randomUUID();
    expect(await eliminarBorradorLocal(db, id)).toBe(false);
    expect(await eliminarMensajeFantasma(db, id)).toBe(false);
  });
});
