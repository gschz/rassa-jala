import "fake-indexeddb/auto";

import { addRxPlugin, createRxDatabase } from "rxdb/plugins/core";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
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
check(
  "local write visible in the writing instance",
  readBack != null && readBack.nombre === doc.nombre,
);
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
check(
  "sorted live-query path reads persisted docs",
  sorted.length === 1 && sorted[0].id === doc.id,
);
await db2.close();

// DVM1 regression check — mirrors the dev browser path (RxDB dev-mode plugin
// + ajv-validated storage): opening must not throw DVM1, a valid write must
// pass, and a schema-invalid write must be rejected by the validator.
addRxPlugin(RxDBDevModePlugin);
const devDb = await createRxDatabase({
  name: DB_NAME + "-dvm1",
  storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS) }),
  multiInstance: false,
  ignoreDuplicate: true,
});
await devDb.addCollections({ localidades: { ...collectionCreators.localidades } });
let devWriteOk = false;
try {
  await devDb.localidades.insert({ ...doc, id: "dvm1-valid" });
  devWriteOk = true;
} catch {
  devWriteOk = false;
}
check("dev-mode validated storage accepts a valid write", devWriteOk);
let invalidRejected = false;
try {
  await devDb.localidades.insert({
    ...doc,
    id: "dvm1-invalid",
    version: "not-a-number",
  } as unknown as LocalidadDoc);
} catch {
  invalidRejected = true;
}
check("dev-mode validated storage rejects a schema-invalid write", invalidRejected);
await devDb.close();

if (failures > 0) process.exit(1);
