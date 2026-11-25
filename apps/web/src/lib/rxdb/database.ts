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
import { RxDBDevModePlugin, disableWarnings } from "rxdb/plugins/dev-mode";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

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

// Stage A COL23 (M-18, chat P1-D): the `unidades` RxDB slot was FREED — the collection
// moved to server-fetched reads (tRPC `catalogos.unidadesList`); the offline CRUD of
// unidades is an ACCEPTED COST (user decision 2026-11-20).

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

// P0 Productos (Q-19): master catalog (Admin-owned writes, global read) + image
// references (D-1 storage adapter; url/storageKey refs only — binaries never sync).
export type ProductoDoc = {
  id: string;
  nombre: string;
  descripcion: string | null;
  fkCategoria: string;
  fkUnidad: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
};

export type ImagenDoc = {
  // M-11 XOR: maestro images carry fkProducto, weekly-item images carry
  // fkProductoSemanal — exactly one is set.
  fkProducto: string | null;
  fkProductoSemanal?: string | null;
  id: string;
  storageKey: string;
  url: string;
  orden: number;
  principal: boolean;
  estado: boolean;
  version: number;
  actualizadoEn: string;
};

// P0 Publicaciones (Q-25): S2 with real offline writes. Drafts are created/edited
// locally and pushed; publish/cancelar/cerrar are online tRPC (never raw push docs).
export type PublicacionDoc = {
  id: string;
  fkAgricultor: string | null;
  // 'YYYY-MM-DD' — the ciclo's ISO Monday date.
  fechaCiclo: string;
  semanaIso: number;
  anioIso: number;
  estado: string;
  version: number;
  actualizadoEn: string;
  /** Idempotency key assigned once by the local write path; cleared by the pull round-trip. */
  syncOpId?: string;
};

// Weekly offer item (money as string, F-29). estado lifecycle 'activo'/'inactivo'
// (quitar = soft state change, legacy parity).
export type ItemSemanalDoc = {
  id: string;
  fkPublicacion: string;
  fkProducto: string;
  fkUnidad: string;
  precio: string;
  stock: number;
  estado: string;
  // G2: farmer name embedded server-side on pull (no usuarios collection — COL23
  // cap); local drafts carry none until the push round-trips — optional like syncOpId.
  agricultorNombre?: string | null;
  version: number;
  actualizadoEn: string;
  syncOpId?: string;
};

// P0 Pedidos (M-12): order header. Pulled docs carry the server snapshots; the OFFLINE
// draft (created at checkout without connection) carries `items` (the cart lines the
// push needs) + `syncOpId` (idempotency key, §7) — both disappear when the confirmed
// server state round-trips back via PULL. While `syncOpId` is present the order is
// "Pendiente de confirmación" — NEVER shown as confirmed (scope.md §6).
//
// §6.2 maps pedido_cabecera + detalle_pedido into ONE collection: pulled docs carry the
// lines EMBEDDED in `detalles` (drafts have none until the server round-trip). RxDB's
// free tier caps a process at 13 open collections, so there is NO separate
// detallesPedido client collection (the server keeps a scoped sync.detallesPedido.pull
// endpoint for narrow clients).
export type PedidoItemLocal = {
  fkProductoSemanal: string;
  cantidad: number;
};

export type DetallePedidoInline = {
  id: string;
  fkProductoSemanal: string;
  nombreProducto: string;
  cantidad: number;
  precioUnitario: string;
  importe: string;
};

export type PedidoDoc = {
  id: string;
  // M-19: human-readable folio PED-000001 — server-assigned (absent on local drafts).
  folio?: string;
  fkCliente: string | null;
  fkVendedor: string | null;
  estadoNombre: string;
  estado: boolean;
  // Money snapshots as strings (F-29). On a local draft these are display-only
  // estimates (integer-cent math); the server snapshot is the ONLY authority.
  subtotal: string;
  iva: string;
  total: string;
  origen: string;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  notas: string | null;
  version: number;
  actualizadoEn: string;
  items?: PedidoItemLocal[];
  detalles?: DetallePedidoInline[];
  syncOpId?: string;
};

// Cart line — LOCAL collection, NO replication (docs/database.md §6.2: the cart is a
// client-side convenience; only the pushed order is business data). One line per weekly
// offer (id = fkProductoSemanal). `precio` is the display-only snapshot at add time.
export type CarritoDoc = {
  id: string;
  fkProductoSemanal: string;
  nombre: string;
  precio: string;
  cantidad: number;
  stock: number;
  agregadoEn: string;
};

// P1-D Chat (M-18): the ONLY S3 bidirectional collection. leido/editado are
// server-owned; a locally-queued draft carries `syncOpId` (idempotency key, §7) that
// disappears when the confirmed server state round-trips via PULL. Offline drafts set
// `leido/editado=false` and `version=0` — the server adjudicates the create.
// T17 (gap-pass-7): tipo/archivoUrl arrive INSIDE the mensajes PULL payload (the
// documento row is NOT a collection — its bytes upload over HTTP and only the URL
// travels). Offline drafts are TEXT-ONLY: an attachment needs the online upload, so
// drafts always carry tipo "texto" / archivoUrl null.
export type MensajeDoc = {
  id: string;
  fkConversacion: string;
  fkAutor: string | null;
  /** Server-side projection (persona join); local drafts carry their author implicitly. */
  autorNombre: string | null;
  contenido: string | null;
  tipo: string;
  archivoUrl: string | null;
  leido: boolean;
  editado: boolean;
  estado: boolean;
  version: number;
  creadoEn: string;
  actualizadoEn: string;
  syncOpId?: string;
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

export const productosSchema: RxJsonSchema<ProductoDoc> = {
  title: "producto",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    nombre: { type: "string" },
    descripcion: { type: ["string", "null"] },
    fkCategoria: { type: "string", maxLength: 36 },
    fkUnidad: { type: ["string", "null"], maxLength: 36 },
    estado: { type: "boolean" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
  },
  required: [
    "id",
    "nombre",
    "descripcion",
    "fkCategoria",
    "fkUnidad",
    "estado",
    "version",
    "actualizadoEn",
  ],
};

export const imagenesSchema: RxJsonSchema<ImagenDoc> = {
  title: "producto_imagen",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    fkProducto: { type: ["string", "null"], maxLength: 36 },
    fkProductoSemanal: { type: ["string", "null"], maxLength: 36 },
    storageKey: { type: "string" },
    url: { type: "string" },
    orden: { type: "integer" },
    principal: { type: "boolean" },
    estado: { type: "boolean" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
  },
  required: [
    "id",
    "fkProducto",
    "storageKey",
    "url",
    "orden",
    "principal",
    "estado",
    "version",
    "actualizadoEn",
  ],
};

export const publicacionesSchema: RxJsonSchema<PublicacionDoc> = {
  title: "publicacion_semanal",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    fkAgricultor: { type: ["string", "null"], maxLength: 36 },
    fechaCiclo: { type: "string" },
    semanaIso: { type: "integer" },
    anioIso: { type: "integer" },
    estado: { type: "string" },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
    syncOpId: { type: "string", maxLength: 36 },
  },
  required: [
    "id",
    "fkAgricultor",
    "fechaCiclo",
    "semanaIso",
    "anioIso",
    "estado",
    "version",
    "actualizadoEn",
  ],
};

export const itemsSemanalesSchema: RxJsonSchema<ItemSemanalDoc> = {
  title: "producto_semanal",
  // v1 (G2): additive agricultorNombre field. Version bumped so IndexedDB re-indexes
  // (RxDB DB6: same version + different fields = schema-hash mismatch). No data
  // transform: pre-G2 docs keep no farmer name until the next pull round-trip.
  version: 1,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    fkPublicacion: { type: "string", maxLength: 36 },
    fkProducto: { type: "string", maxLength: 36 },
    fkUnidad: { type: "string", maxLength: 36 },
    // numeric(10,2) serialized as string (F-29: money never as float).
    precio: { type: "string" },
    stock: { type: "integer" },
    estado: { type: "string" },
    // Not in `required`: local drafts and pre-G2 docs carry no farmer name.
    agricultorNombre: { type: ["string", "null"] },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
    syncOpId: { type: "string", maxLength: 36 },
  },
  required: [
    "id",
    "fkPublicacion",
    "fkProducto",
    "fkUnidad",
    "precio",
    "stock",
    "estado",
    "version",
    "actualizadoEn",
  ],
};

export const pedidosSchema: RxJsonSchema<PedidoDoc> = {
  title: "pedido",
  // v1 (M-19): `folio` added by the folio gap pass. Version bumped so IndexedDB
  // re-indexes (RxDB DB6: same version + different fields = schema-hash mismatch).
  // No data transform: local drafts keep null folio; confirmed rows refetch it.
  version: 1,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    // M-19: server-assigned folio (optional — local drafts carry none until confirmed).
    folio: { type: "string", maxLength: 10 },
    fkCliente: { type: ["string", "null"], maxLength: 36 },
    fkVendedor: { type: ["string", "null"], maxLength: 36 },
    estadoNombre: { type: "string" },
    estado: { type: "boolean" },
    // Money snapshots as strings (F-29).
    subtotal: { type: "string" },
    iva: { type: "string" },
    total: { type: "string" },
    origen: { type: "string" },
    clienteNombre: { type: ["string", "null"] },
    clienteTelefono: { type: ["string", "null"] },
    notas: { type: ["string", "null"] },
    version: { type: "integer" },
    actualizadoEn: { type: "string" },
    // Offline-draft only: the cart lines the push sends (gone after the pull round-trip).
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fkProductoSemanal: { type: "string", maxLength: 36 },
          cantidad: { type: "integer" },
        },
        required: ["fkProductoSemanal", "cantidad"],
      },
    },
    // Server-pulled docs embed the order lines (§6.2 one-collection grain; optional —
    // drafts carry none until the confirmed state round-trips).
    detalles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", maxLength: 36 },
          fkProductoSemanal: { type: "string", maxLength: 36 },
          nombreProducto: { type: "string" },
          cantidad: { type: "integer" },
          precioUnitario: { type: "string" },
          importe: { type: "string" },
        },
        required: [
          "id",
          "fkProductoSemanal",
          "nombreProducto",
          "cantidad",
          "precioUnitario",
          "importe",
        ],
      },
    },
    syncOpId: { type: "string", maxLength: 36 },
  },
  required: [
    "id",
    "fkCliente",
    "fkVendedor",
    "estadoNombre",
    "estado",
    "subtotal",
    "iva",
    "total",
    "origen",
    "clienteNombre",
    "clienteTelefono",
    "notas",
    "version",
    "actualizadoEn",
  ],
};

export const carritoSchema: RxJsonSchema<CarritoDoc> = {
  title: "carrito",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    fkProductoSemanal: { type: "string", maxLength: 36 },
    nombre: { type: "string" },
    precio: { type: "string" },
    cantidad: { type: "integer" },
    stock: { type: "integer" },
    agregadoEn: { type: "string" },
  },
  required: ["id", "fkProductoSemanal", "nombre", "precio", "cantidad", "stock", "agregadoEn"],
};

export const mensajesSchema: RxJsonSchema<MensajeDoc> = {
  title: "mensaje",
  // v1 (T17, gap-pass-7): additive tipo/archivoUrl fields. Version bumped so IndexedDB
  // re-indexes (RxDB DB6: same version + different fields = schema-hash mismatch).
  // Not in `required`: tombstones and pre-T17 docs need no defaults to validate.
  version: 1,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
    fkConversacion: { type: "string", maxLength: 36 },
    fkAutor: { type: ["string", "null"], maxLength: 36 },
    autorNombre: { type: ["string", "null"] },
    contenido: { type: ["string", "null"] },
    tipo: { type: "string", maxLength: 10 },
    archivoUrl: { type: ["string", "null"] },
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
  familias: RxCollection<FamiliaDoc>;
  membresias: RxCollection<MembresiaDoc>;
  limites_credito: RxCollection<LimiteCreditoDoc>;
  productos: RxCollection<ProductoDoc>;
  imagenes: RxCollection<ImagenDoc>;
  publicaciones: RxCollection<PublicacionDoc>;
  itemsSemanales: RxCollection<ItemSemanalDoc>;
  // P0 Pedidos: `pedidos` replicates (scoped, lines EMBEDDED — free RxDB cap of 13 open
  // collections forbids a separate detallesPedido/estadosPedido client collection);
  // `carrito` is LOCAL-only (never registered in replication.ts — database.md §6.2 keeps
  // the cart out of sync).
  pedidos: RxCollection<PedidoDoc>;
  carrito: RxCollection<CarritoDoc>;
  // P1-D Chat (M-18): the S3 bidirectional collection (13th creator — COL23 slot freed
  // by the stage-A `unidades` removal).
  mensajes: RxCollection<MensajeDoc>;
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
  productos: {
    schema: productosSchema,
    conflictHandler: serverWinsConflictHandler<ProductoDoc>(),
  },
  imagenes: {
    schema: imagenesSchema,
    conflictHandler: serverWinsConflictHandler<ImagenDoc>(),
  },
  publicaciones: {
    schema: publicacionesSchema,
    conflictHandler: serverWinsConflictHandler<PublicacionDoc>(),
  },
  itemsSemanales: {
    schema: itemsSemanalesSchema,
    conflictHandler: serverWinsConflictHandler<ItemSemanalDoc>(),
    // v0→v1 (G2): additive agricultorNombre field, no local transform needed.
    migrationStrategies: {
      1: (doc: ItemSemanalDoc): ItemSemanalDoc => doc,
    },
  },
  pedidos: {
    schema: pedidosSchema,
    conflictHandler: serverWinsConflictHandler<PedidoDoc>(),
    // v0→v1 (M-19): additive folio field, no local transform needed.
    migrationStrategies: {
      1: (doc: PedidoDoc): PedidoDoc => doc,
    },
  },
  carrito: { schema: carritoSchema },
  mensajes: {
    schema: mensajesSchema,
    conflictHandler: serverWinsConflictHandler<MensajeDoc>(),
    // v0→v1 (T17): additive tipo/archivoUrl fields; pre-attachment messages are all
    // text — fill honest defaults so local docs always carry the fields.
    migrationStrategies: {
      1: (doc: MensajeDoc): MensajeDoc => ({
        ...doc,
        tipo: doc.tipo ?? "texto",
        archivoUrl: doc.archivoUrl ?? null,
      }),
    },
  },
};

const DB_NAME = "rassajala";

// Vite HMR re-evaluates this module in dev and would open the same database
// twice. `ignoreDuplicate` skips the duplicate-name check, but RxDB only
// allows that flag when its dev-mode plugin is registered (DB9 otherwise),
// so both are dev-only: a production bundle opens the database exactly once.
const isDev = import.meta.env.DEV;
if (isDev) {
  addRxPlugin(RxDBDevModePlugin);
  disableWarnings();
}
// Required for schema-version migrations (M-19: pedidos v0→v1 folio). Dev-mode
// pre-checks pass without it, but the migration itself throws pluginMissing.
addRxPlugin(RxDBMigrationSchemaPlugin);

// DVM1: with dev-mode enabled the top-level storage must perform schema
// validation (rxdb.info/errors#DVM1). Ajv-wrapped Dexie satisfies it in dev;
// production skips the wrapper for performance, per RxDB guidance.
const storage = isDev
  ? wrappedValidateAjvStorage({ storage: getRxStorageDexie() })
  : getRxStorageDexie();

let dbPromise: Promise<RassaDatabase> | null = null;

/**
 * Insecure contexts (plain-HTTP LAN testing)
 * do NOT expose `crypto.subtle` — RxDB's nativeSha256 then crashes every
 * addCollections with RxError UT8 and whole views die (QA F17-r3, user report).
 * In that case pass a pure-JS sha256 (HashFunction contract: input string |
 * ArrayBuffer | Blob -> hex string); secure contexts keep the native default.
 */
function hashFnSeguro(): ((input: string | ArrayBuffer | Blob) => Promise<string>) | undefined {
  if (typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function") {
    return undefined; // secure context: RxDB native Web Crypto path
  }
  return async (input) => {
    const bytes =
      typeof input === "string"
        ? new TextEncoder().encode(input)
        : input instanceof Blob
          ? new Uint8Array(await input.arrayBuffer())
          : new Uint8Array(input);
    return bytesToHex(sha256(bytes));
  };
}

/** Singleton app database; collections are created once and reused. */
export function getDatabase(): Promise<RassaDatabase> {
  dbPromise ??= createRxDatabase<RassaCollections>({
    name: DB_NAME,
    storage,
    hashFunction: hashFnSeguro(),
    ...(isDev ? { ignoreDuplicate: true } : {}),
  }).then(async (db) => {
    await db.addCollections(collectionCreators);
    return db as RassaDatabase;
  });
  return dbPromise;
}

/**
 * Normative sync §11 purge: close the open RxDB handle (otherwise
 * `indexedDB.deleteDatabase` stays BLOCKED forever) and drop the Dexie files.
 * Used on account change (session.ts) — the next login recreates everything
 * fresh. Fire-and-forget from the caller; the page reloads when done.
 */
export function purgarBaseLocal(): void {
  const cerrar = async (): Promise<void> => {
    try {
      const db = (await dbPromise) as RassaDatabase | null;
      void db?.close();
    } catch {
      // nothing open — fine
    }
    dbPromise = null;
    await Promise.all(
      (await indexedDB.databases()).map(
        (info) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(info.name ?? "");
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          }),
      ),
    );
    location.reload();
  };
  void cerrar();
}
