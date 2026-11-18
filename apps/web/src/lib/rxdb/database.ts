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
  version: 0,
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
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 36 },
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
  },
  pedidos: {
    schema: pedidosSchema,
    conflictHandler: serverWinsConflictHandler<PedidoDoc>(),
  },
  carrito: { schema: carritoSchema },
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
