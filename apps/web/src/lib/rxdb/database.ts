import {
  addRxPlugin,
  createRxDatabase,
  deepEqual,
  type RxCollection,
  type RxConflictHandler,
  type RxDatabase,
  type RxJsonSchema,
} from "rxdb/plugins/core";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";

/**
 * RxDB collections for the vertical slice (docs/database.md §6.2), with JSON
 * schemas mirroring the server row shape after the §6.3 transforms:
 * - snake_case columns -> camelCase fields.
 * - doc id = server PK string (P-1, docs/database.md §5.3).
 * - `estado=false` soft-deletes are emitted by the server as `_deleted: true`
 *   while conserving `estado` (§6.3.5), so the client keeps RxDB's default
 *   `deletedField: '_deleted'`.
 * - `version` mirrors the server optimistic-concurrency column (SP-2).
 */

export type MunicipioDoc = {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
};

export type LocalidadDoc = {
  id: string;
  nombre: string;
  fkMunicipio: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  /**
   * Idempotency key assigned once by the local write path (sync doc §7,
   * normative design). Server-pulled documents do not carry it, so it stays
   * on the doc until the confirmed server state round-trips back via PULL.
   */
  syncOpId?: string;
};

export type CategoriaDoc = {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
};

export type UnidadDoc = {
  id: string;
  nombre: string;
  abreviatura?: string;
  tipo?: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
};

// P0 Familias (doc-deviation of database.md §6.2's single `familias` row): three PULL-only
// scoped collections — `familias` (admin: all; member: own), `membresias` (own rows + the
// roster of the user's family; carries `correo` for roster rendering) and
// `limites_credito` (own user limit + family limit; money as string, F-29). See
// sync.ts on the server for the trigger-based re-delivery rationale.
export type FamiliaDoc = {
  id: string;
  nombre: string;
  fkJefeUsuario: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
};

export type MembresiaDoc = {
  id: string;
  fkUsuario: string;
  fkFamilia: string;
  correo: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
};

export type LimiteCreditoDoc = {
  id: string;
  monto: string;
  fkFamilia: string | null;
  fkUsuario: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
};

export const municipiosSchema: RxJsonSchema<MunicipioDoc> = {
  title: "municipio",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    nombre: { type: "string" },
    estado: { type: "boolean" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
  },
  required: ["id", "nombre", "estado", "version", "actualizadoEn"],
};

export const localidadesSchema: RxJsonSchema<LocalidadDoc> = {
  title: "localidad",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    nombre: { type: "string" },
    fkMunicipio: { type: "string", maxLength: 36 },
    estado: { type: "boolean" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
    syncOpId: { type: "string", maxLength: 36 },
  },
  required: ["id", "nombre", "fkMunicipio", "estado", "version", "actualizadoEn"],
};

export const categoriasSchema: RxJsonSchema<CategoriaDoc> = {
  title: "categoria_producto",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    nombre: { type: "string" },
    estado: { type: "boolean" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
  },
  required: ["id", "nombre", "estado", "version", "actualizadoEn"],
};

export const unidadesSchema: RxJsonSchema<UnidadDoc> = {
  title: "unidad",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    nombre: { type: "string" },
    // Legacy-compat nullable columns (DA §8.4); sent when present.
    abreviatura: { type: "string" },
    tipo: { type: "string" },
    estado: { type: "boolean" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
  },
  required: ["id", "nombre", "estado", "version", "actualizadoEn"],
};

export const familiasSchema: RxJsonSchema<FamiliaDoc> = {
  title: "familia",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    nombre: { type: "string" },
    fkJefeUsuario: { type: ["string", "null"], maxLength: 36 },
    estado: { type: "boolean" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
  },
  required: ["id", "nombre", "fkJefeUsuario", "estado", "version", "actualizadoEn"],
};

export const membresiasSchema: RxJsonSchema<MembresiaDoc> = {
  title: "familia_usuario",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    fkUsuario: { type: "string", maxLength: 36 },
    fkFamilia: { type: "string", maxLength: 36 },
    correo: { type: "string" },
    estado: { type: "boolean" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
  },
  required: ["id", "fkUsuario", "fkFamilia", "correo", "estado", "version", "actualizadoEn"],
};

export const limitesCreditoSchema: RxJsonSchema<LimiteCreditoDoc> = {
  title: "limite_credito",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    // numeric(12,2) serialized as string (F-29: money never as float).
    monto: { type: "string" },
    fkFamilia: { type: ["string", "null"], maxLength: 36 },
    fkUsuario: { type: ["string", "null"], maxLength: 36 },
    estado: { type: "boolean" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
  },
  required: ["id", "monto", "fkFamilia", "fkUsuario", "estado", "version", "actualizadoEn"],
};

/**
 * S1 conflict policy (sync doc §6): the central state always wins.
 * doc-deviation: sync doc §2.1 shows conflictHandler as a bare function
 * returning `{ documentData: i.realMasterState }` (the old RxConflictHandlerOld
 * shape); installed rxdb 17.6.0 expects an object `{ isEqual, resolve }` where
 * `resolve` returns the resolved document directly.
 */
export function serverWinsConflictHandler<TDoc>(): RxConflictHandler<TDoc> {
  return {
    isEqual: (a, b) => deepEqual(a, b),
    // The installed API types `resolve` as async; it is awaited by the
    // replication protocol.
    resolve: async (i) => i.realMasterState,
  };
}

export type RassaCollections = {
  municipios: RxCollection<MunicipioDoc>;
  localidades: RxCollection<LocalidadDoc>;
  categorias: RxCollection<CategoriaDoc>;
  unidades: RxCollection<UnidadDoc>;
  familias: RxCollection<FamiliaDoc>;
  membresias: RxCollection<MembresiaDoc>;
  limites_credito: RxCollection<LimiteCreditoDoc>;
};

export type RassaDatabase = RxDatabase<RassaCollections>;

export const collectionCreators = {
  municipios: {
    schema: municipiosSchema,
    conflictHandler: serverWinsConflictHandler<MunicipioDoc>(),
  },
  localidades: {
    schema: localidadesSchema,
    conflictHandler: serverWinsConflictHandler<LocalidadDoc>(),
  },
  categorias: {
    schema: categoriasSchema,
    conflictHandler: serverWinsConflictHandler<CategoriaDoc>(),
  },
  unidades: {
    schema: unidadesSchema,
    conflictHandler: serverWinsConflictHandler<UnidadDoc>(),
  },
  familias: {
    schema: familiasSchema,
    conflictHandler: serverWinsConflictHandler<FamiliaDoc>(),
  },
  membresias: {
    schema: membresiasSchema,
    conflictHandler: serverWinsConflictHandler<MembresiaDoc>(),
  },
  limites_credito: {
    schema: limitesCreditoSchema,
    conflictHandler: serverWinsConflictHandler<LimiteCreditoDoc>(),
  },
};

const DB_NAME = "rassajala";

// Vite HMR re-evaluates this module in dev and would open the same database
// twice. `ignoreDuplicate` skips the duplicate-name check, but RxDB only
// allows that flag when its dev-mode plugin is registered (DB9 otherwise),
// so both are dev-only: a production bundle opens the database exactly once.
const isDev = import.meta.env.DEV;
if (isDev) addRxPlugin(RxDBDevModePlugin);

// DVM1: with dev-mode enabled the top-level storage must perform schema
// validation (rxdb.info/errors#DVM1). Ajv-wrapped Dexie satisfies it in dev;
// production skips the wrapper for performance, per RxDB guidance.
const storage = isDev
  ? wrappedValidateAjvStorage({ storage: getRxStorageDexie() })
  : getRxStorageDexie();

let dbPromise: Promise<RassaDatabase> | null = null;

/** Singleton app database; collections are created once and reused. */
export function getDatabase(): Promise<RassaDatabase> {
  dbPromise ??= createRxDatabase<RassaCollections>({
    name: DB_NAME,
    storage,
    ...(isDev ? { ignoreDuplicate: true } : {}),
  }).then(async (db) => {
    await db.addCollections(collectionCreators);
    return db as RassaDatabase;
  });
  return dbPromise;
}
