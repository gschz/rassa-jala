import "fake-indexeddb/auto";

import { addRxPlugin, createRxDatabase } from "rxdb/plugins/core";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import { collectionCreators, type LocalidadDoc, type MensajeDoc } from "../src/lib/rxdb/database";

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

// ---- mensajes (P1-D, S3): T2 (gap-pass-8) pins the collection the UI timeline
// reads. Three cases the API-level e2e never exercises:
// (a) an offline draft insert (chat.tsx's exact borrador shape) under the dev ajv
//     wrapper (DVM1) — a rejected insert is the "sent message never appears" bug;
// (b) a PULL-shaped server doc (tipo "imagen" + archivoUrl) writes through ajv;
// (c) the v0→v1 schema migration with the EXACT pre-gap-pass-7 v0 schema (git HEAD)
//     — a broken migration hides the owner's existing history.
const ahora = new Date().toISOString();
const borrador: MensajeDoc = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  fkConversacion: "bbbbbbbb-1111-4111-8111-111111111111",
  fkAutor: "cccccccc-1111-4111-8111-111111111111",
  autorNombre: null,
  contenido: "borrador offline",
  tipo: "texto",
  archivoUrl: null,
  leido: false,
  editado: false,
  estado: true,
  version: 0,
  creadoEn: ahora,
  actualizadoEn: ahora,
  syncOpId: "dddddddd-1111-4111-8111-111111111111",
};
const pullImagen: MensajeDoc = {
  ...borrador,
  id: "aaaaaaaa-2222-4222-8222-222222222222",
  autorNombre: "Admin Rassa",
  contenido: null,
  tipo: "imagen",
  archivoUrl: "/storage/documentos/x.png",
  version: 1,
  syncOpId: undefined,
};

const dbMensajes = await createRxDatabase({
  name: DB_NAME + "-mensajes",
  storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS) }),
  multiInstance: false,
  ignoreDuplicate: true,
});
await dbMensajes.addCollections({ mensajes: { ...collectionCreators.mensajes } });
let borradorOk = false;
try {
  await dbMensajes.mensajes.insert(borrador);
  borradorOk = true;
} catch (error) {
  console.log("borrador insert error:", error);
}
check("mensajes: offline draft (texto) inserts under the dev ajv wrapper", borradorOk);
let imagenOk = false;
try {
  await dbMensajes.mensajes.insert(pullImagen);
  imagenOk = true;
} catch (error) {
  console.log("pull-shaped insert error:", error);
}
check("mensajes: pull-shaped imagen doc (archivoUrl) inserts under ajv", imagenOk);
await dbMensajes.close();

// (c) v0 → v1: open a DB with the EXACT v0 schema (git HEAD), seed a doc, then
// reopen with the CURRENT creator — the migration must fill tipo/archivoUrl.
// The EXACT v0 schema (git HEAD) — intentionally WITHOUT tipo/archivoUrl, hence the
// loose typing: this is the pre-gap-pass-7 shape, not a partial v1.
const mensajesSchemaV0 = {
  title: "mensaje",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    fkConversacion: { type: "string", maxLength: 36 },
    fkAutor: { type: ["string", "null"], maxLength: 36 },
    autorNombre: { type: ["string", "null"] },
    contenido: { type: ["string", "null"] },
    leido: { type: "boolean" },
    editado: { type: "boolean" },
    estado: { type: "boolean" },
    version: { type: "integer" },
    creadoEn: { type: "string" },
    actualizadoEn: { type: "string" },
    syncOpId: { type: "string", maxLength: 36 },
  },
  required: [
    "id",
    "fkConversacion",
    "fkAutor",
    "autorNombre",
    "contenido",
    "leido",
    "editado",
    "estado",
    "version",
    "creadoEn",
    "actualizadoEn",
  ],
};
const v0Doc = {
  id: "aaaaaaaa-3333-4333-8333-333333333333",
  fkConversacion: "bbbbbbbb-1111-4111-8111-111111111111",
  fkAutor: null,
  autorNombre: "Autor viejo",
  contenido: "Hola (v0)",
  leido: false,
  editado: false,
  estado: true,
  version: 1,
  creadoEn: ahora,
  actualizadoEn: ahora,
};
const dbV0 = await createRxDatabase({
  name: DB_NAME + "-mensajes-mig",
  storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS) }),
  multiInstance: false,
});
await dbV0.addCollections({
  mensajes: { schema: mensajesSchemaV0 as unknown as typeof collectionCreators.mensajes.schema },
});
await dbV0.mensajes.insert(v0Doc as MensajeDoc);
await dbV0.close();

addRxPlugin(RxDBMigrationSchemaPlugin);
const dbMig = await createRxDatabase({
  name: DB_NAME + "-mensajes-mig",
  storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS) }),
  multiInstance: false,
  ignoreDuplicate: true,
});
await dbMig.addCollections({ mensajes: { ...collectionCreators.mensajes } });
const migrado = await dbMig.mensajes.findOne(v0Doc.id).exec();
const jsonMigrado = migrado?.toJSON() as MensajeDoc | undefined;
check(
  "mensajes: v0→v1 migration keeps the old doc and fills tipo/archivoUrl",
  jsonMigrado != null && jsonMigrado.tipo === "texto" && jsonMigrado.archivoUrl === null,
);
await dbMig.close();

if (failures > 0) process.exit(1);
