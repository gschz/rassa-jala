import "fake-indexeddb/auto";

import { createRxDatabase } from "rxdb/plugins/core";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import { collectionCreators, type LocalidadDoc } from "../src/lib/rxdb/database";

/**
 * Proves offline local writes + persistence without the server: a localidad
 * inserted in one RxDB instance must be readable from a NEW RxDB instance
 * over the same IndexedDB store (fake-indexeddb here; real Dexie in the app).
 */

// Bun evaluates the CJS/UMD dexie build before the ESM fake-indexeddb module
// body, so Dexie's captured domDeps are empty even when the globals are set
// by the time the script runs. Pass the fake implementation explicitly
// instead of relying on globals.
const FAKE_DEXIE_SETTINGS = {
  indexedDB: fakeIndexedDB,
  IDBKeyRange: fakeIDBKeyRange,
};

const DB_NAME = "rxdb-check-persistence";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  if (!ok) failures += 1;
}

const doc: LocalidadDoc = {
  id: crypto.randomUUID(),
  nombre: "Tepic Centro (escritura offline)",
  fkMunicipio: crypto.randomUUID(),
  estado: true,
  version: 0,
  actualizadoEn: new Date().toISOString(),
  syncOpId: crypto.randomUUID(),
};

// Instance 1 — offline local write, then close.
const db1 = await createRxDatabase({
  name: DB_NAME,
  storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS),
  multiInstance: false,
});
await db1.addCollections({ localidades: { ...collectionCreators.localidades } });
await db1.localidades.insert(doc);
const readBack = await db1.localidades.findOne(doc.id).exec();
check("local write visible in the writing instance", readBack != null && readBack.nombre === doc.nombre);
await db1.close();

// Instance 2 — a fresh RxDB over the same store proves persistence.
const db2 = await createRxDatabase({
  name: DB_NAME,
  storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS),
  multiInstance: false,
});
await db2.addCollections({ localidades: { ...collectionCreators.localidades } });
const persisted = await db2.localidades.findOne(doc.id).exec();
const persistedData = persisted?.toJSON() as LocalidadDoc | undefined;
check(
  "local write persists across a new RxDB instance (IndexedDB)",
  persistedData != null &&
    persistedData.nombre === doc.nombre &&
    persistedData.fkMunicipio === doc.fkMunicipio &&
    persistedData.syncOpId === doc.syncOpId &&
    persistedData.version === doc.version,
);
// The UI lists live queries with sort; prove the sorted-find path too.
const sorted = await db2.localidades.find({ sort: [{ nombre: "asc" }] }).exec();
check("sorted live-query path reads persisted docs", sorted.length === 1 && sorted[0].id === doc.id);
await db2.close();

if (failures > 0) process.exit(1);
