import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  ESTADO_ITEM_SEMANAL,
  ESTADO_PUBLICACION,
  ORIGEN_PEDIDO,
  aFechaCiclo,
  esLunesFecha,
  isoWeekFromMonday,
  mondayOfBusinessWeek,
  parseFechaCiclo,
} from "@rassa-jala/db";
import type { Database, Prisma } from "@rassa-jala/db";

import { protectedProcedure, router } from "../index";
import { ROLE } from "../context";
import { adjudicarPedido, Rechazo } from "./pedidos";

// Synchronization protocol — normative sources: docs/synchronization.md (§4 PULL, §5 PUSH,
// §7 idempotency, §8 deletions, §11 user isolation, §14 slice scope) and docs/database.md
// (§6.2 collection map, §6.3 document↔row transform, §7.1 M-1a/M-1b/M-8/M-9, SP-2/SP-3).

export const COLECCIONES = [
  "municipios",
  "localidades",
  "categorias",
  "unidades",
  // P0 Familias (M-9): scoped collections — admin sees all, members only their own
  // family data (§11: scoping revalidated per pull; checkpoints are per user).
  "familias",
  "membresias",
  "limites_credito",
  // P0 Usuarios (§6.2 `usuarios` row): roster scoping — admin → all; non-admin → self +
  // members of their own active family. Read-only for clients (perfil edits are S4 tRPC).
  "usuarios",
  // P0 Productos (Q-19): Admin-owned master catalog + image references. PULL-only
  // (writes are online tRPC procedures); docs carry url/storageKey refs, never binaries.
  "productos",
  "imagenes",
  // P0 Publicaciones (Q-25): the FIRST real S2 push class — farmer DRAFTS replicate
  // (borrador docs only); publish/cancelar/cerrar are online-confirm tRPC mutations.
  "publicaciones",
  "productosSemanales",
  // P0 Pedidos (M-12): S2 creation-in-queue — client order DRAFTS push (server
  // adjudicates stock/credit/estado); pulls are scoped (client own / seller assigned /
  // admin all); `estadosPedido` is a global S1 lookup; `detallesPedido` rides the parent
  // order's visibility.
  "pedidos",
  "detallesPedido",
  "estadosPedido",
] as const;
export type Coleccion = (typeof COLECCIONES)[number];

const VEREDICTO = {
  APLICADA: "aplicada",
  CONFLICTO: "conflicto",
  RECHAZADA: "rechazada",
} as const;
export type Veredicto = (typeof VEREDICTO)[keyof typeof VEREDICTO];

const OPERACION = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
} as const;

// ---- RxDB document shapes (database.md §6.3: camelCase, explicit _deleted, ISO 8601 times) ----

export interface MunicipioDoc {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

export interface LocalidadDoc {
  id: string;
  fkMunicipio: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

export interface CategoriaDoc {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

export interface UnidadDoc {
  id: string;
  tipo: string | null;
  nombre: string | null;
  abreviatura: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// P0 Familias (M-9, doc-deviation of §6.2's single `familias` row): three scoped PULL
// collections. `membresias` carries `correo` so a member's client can render the family
// roster (legacy chat semantics: members see co-members).
export interface FamiliaDoc {
  id: string;
  nombre: string;
  fkJefeUsuario: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

export interface MembresiaDoc {
  id: string;
  fkUsuario: string;
  fkFamilia: string;
  correo: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// Money travels as string (F-29: numeric → string, never float).
export interface LimiteCreditoDoc {
  id: string;
  monto: string;
  fkFamilia: string | null;
  fkUsuario: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// P0 Usuarios (§6.2): identity roster. passwordHash NEVER travels (S4, §6.3.7); correo +
// persona names + rol are the legacy chat-roster surface (members see co-members).
export interface UsuarioDoc {
  id: string;
  correo: string;
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  rol: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// P0 Productos (Q-19): master catalog readable by any authenticated user.
// doc-deviation: database.md §6.2's "agricultor: propios" scoping predates Q-19 — the
// master catalog is Admin-owned (writes), global read scope for all authenticated users.
export interface ProductoDoc {
  id: string;
  nombre: string;
  descripcion: string | null;
  fkCategoria: string;
  fkUnidad: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// Image references only — binaries never travel (D-1): url/storageKey/orden/principal.
// doc-deviation: database.md §6.2's "eliminar_pendiente no replicar" note predates the
// D-1 storage adapter — that Drive state machine no longer exists; a deleted image emits
// a normal outbox 'delete' tombstone like any other hard delete. M-11: the image targets
// EXACTLY ONE owner — the maestro producto (fkProducto) XOR the weekly item
// (fkProductoSemanal).
export interface ImagenDoc {
  id: string;
  fkProducto: string | null;
  fkProductoSemanal: string | null;
  storageKey: string;
  url: string;
  orden: number;
  principal: boolean;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// P0 Publicaciones (Q-25): S2 with real offline writes. The lifecycle varchar is a
// normal synced update — NEVER a tombstone (database.md §6.3.5); the push lane carries
// estado='borrador' docs only (state transitions are online-confirm operations).
export interface PublicacionDoc {
  id: string;
  fkAgricultor: string | null;
  // 'YYYY-MM-DD' — the ciclo's ISO Monday date (Q-25).
  fechaCiclo: string;
  semanaIso: number;
  anioIso: number;
  estado: string;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// Weekly offer item (price/stock snapshot of the ciclo). Money as string (F-29).
export interface ProductoSemanalDoc {
  id: string;
  fkPublicacion: string;
  fkProducto: string;
  fkUnidad: string;
  precio: string;
  stock: number;
  estado: string;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// P0 Pedidos (M-12): S2 order header. estadoNombre mirrors the estado_pedido lookup
// (lifecycle values are NOT tombstones — `estado` boolean stays for the soft-delete
// convention); money snapshots travel as strings (F-29). Clientes físicos docs carry
// clienteNombre/clienteTelefono with fkCliente NULL. §6.2 maps pedido_cabecera +
// detalle_pedido into ONE collection: the lines ride EMBEDDED in `detalles` (they live
// and die with the order) — RxDB's free tier caps a process at 13 open collections, so
// no separate `detallesPedido` client collection exists (the server still exposes the
// scoped sync.detallesPedido.pull endpoint for narrow clients).
export interface DetallePedidoInline {
  id: string;
  fkProductoSemanal: string;
  nombreProducto: string;
  cantidad: number;
  precioUnitario: string;
  importe: string;
}

export interface PedidoDoc {
  id: string;
  fkCliente: string | null;
  fkVendedor: string | null;
  estadoNombre: string;
  estado: boolean;
  subtotal: string;
  iva: string;
  total: string;
  origen: string;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  notas: string | null;
  version: number;
  actualizadoEn: string;
  detalles?: DetallePedidoInline[];
  _deleted: boolean;
}

// Server-only `sync.detallesPedido.pull` line doc (no client collection: the client
// embeds lines in the pedido doc — free RxDB 13-collection cap).
export interface DetallePedidoDoc {
  id: string;
  fkPedido: string;
  fkProductoSemanal: string;
  nombreProducto: string;
  cantidad: number;
  precioUnitario: string;
  importe: string;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// Global S1 state catalog (estados_pedido row: no soft-delete — full PULL). SERVER-ONLY
// endpoint (sync.estadosPedido.pull): the client gets estadoNombre embedded in every
// pedido doc, and the free RxDB collection cap keeps this off the client.
export interface EstadoPedidoDoc {
  id: string;
  nombre: string;
  orden: number;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// Hard deletes leave only a minimal tombstone (synchronization.md §4.3); the slice produces none
// (soft-delete keeps the row), but PULL handles the outbox 'delete' case defensively.
export interface TombstoneDoc {
  id: string;
  _deleted: true;
}

export type MunicipioPullDoc = MunicipioDoc | TombstoneDoc;
export type LocalidadPullDoc = LocalidadDoc | TombstoneDoc;
export type CategoriaPullDoc = CategoriaDoc | TombstoneDoc;
export type UnidadPullDoc = UnidadDoc | TombstoneDoc;
export type FamiliaPullDoc = FamiliaDoc | TombstoneDoc;
export type MembresiaPullDoc = MembresiaDoc | TombstoneDoc;
export type LimiteCreditoPullDoc = LimiteCreditoDoc | TombstoneDoc;
export type UsuarioPullDoc = UsuarioDoc | TombstoneDoc;
export type ProductoPullDoc = ProductoDoc | TombstoneDoc;
export type ImagenPullDoc = ImagenDoc | TombstoneDoc;
export type PublicacionPullDoc = PublicacionDoc | TombstoneDoc;
export type ProductoSemanalPullDoc = ProductoSemanalDoc | TombstoneDoc;
export type PedidoPullDoc = PedidoDoc | TombstoneDoc;
export type DetallePedidoPullDoc = DetallePedidoDoc | TombstoneDoc;
export type EstadoPedidoPullDoc = EstadoPedidoDoc | TombstoneDoc;

export interface ResultadoPush {
  operationId: string;
  docId: string;
  veredicto: Veredicto;
  motivo?: string;
  // Collection-typed at the handler boundary (localidades → LocalidadPullDoc,
  // publicaciones → PublicacionPullDoc, productosSemanales → ProductoSemanalPullDoc);
  // the stored JSON verdict is parsed per collection.
  estadoServidor?: unknown;
}

// ---- Prisma row types ----

type ElementoDe<A> = A extends readonly (infer T)[] ? T : never;
type FilaSyncCambio = ElementoDe<Awaited<ReturnType<Database["syncCambio"]["findMany"]>>>;
type FilaSyncOperacion = ElementoDe<Awaited<ReturnType<Database["syncOperacion"]["findMany"]>>>;
type FilaLocalidad = ElementoDe<Awaited<ReturnType<Database["localidad"]["findMany"]>>>;
type FilaMunicipio = ElementoDe<Awaited<ReturnType<Database["municipio"]["findMany"]>>>;
type FilaCategoria = ElementoDe<Awaited<ReturnType<Database["categoriaProducto"]["findMany"]>>>;
type FilaUnidad = ElementoDe<Awaited<ReturnType<Database["unidad"]["findMany"]>>>;
type FilaFamilia = ElementoDe<Awaited<ReturnType<Database["familia"]["findMany"]>>>;
type FilaMembresia = ElementoDe<Awaited<ReturnType<Database["familiaUsuario"]["findMany"]>>>;
type FilaLimite = ElementoDe<Awaited<ReturnType<Database["limiteCredito"]["findMany"]>>>;
type FilaProducto = ElementoDe<Awaited<ReturnType<Database["producto"]["findMany"]>>>;
type FilaImagen = ElementoDe<Awaited<ReturnType<Database["productoImagen"]["findMany"]>>>;
type FilaPublicacion = ElementoDe<Awaited<ReturnType<Database["publicacionSemanal"]["findMany"]>>>;
type FilaItemSemanal = ElementoDe<Awaited<ReturnType<Database["productoSemanal"]["findMany"]>>>;
type FilaPedido = ElementoDe<Awaited<ReturnType<Database["pedidoCabecera"]["findMany"]>>>;
type FilaDetallePedido = ElementoDe<Awaited<ReturnType<Database["detallePedido"]["findMany"]>>>;
type FilaEstadoPedido = ElementoDe<Awaited<ReturnType<Database["estadoPedido"]["findMany"]>>>;

// ---- PULL (§4) ----

const GAP_WINDOW_MS = 60_000;
// slice-decision: margin N for gap evaluation over the base query (§4.3 "LIMIT límite + N").
const GAP_MARGIN = 20;

const TABLA_POR_COLECCION: Record<Coleccion, string> = {
  municipios: "municipio",
  localidades: "localidad",
  categorias: "categoria_producto",
  unidades: "unidad",
  familias: "familia",
  membresias: "familia_usuario",
  limites_credito: "limite_credito",
  usuarios: "usuario",
  productos: "producto",
  imagenes: "producto_imagen",
  publicaciones: "publicacion_semanal",
  productosSemanales: "producto_semanal",
  pedidos: "pedido_cabecera",
  detallesPedido: "detalle_pedido",
  estadosPedido: "estado_pedido",
};

type DocPullDe<C extends Coleccion> = {
  municipios: MunicipioPullDoc;
  localidades: LocalidadPullDoc;
  categorias: CategoriaPullDoc;
  unidades: UnidadPullDoc;
  familias: FamiliaPullDoc;
  membresias: MembresiaPullDoc;
  limites_credito: LimiteCreditoPullDoc;
  usuarios: UsuarioPullDoc;
  productos: ProductoPullDoc;
  imagenes: ImagenPullDoc;
  publicaciones: PublicacionPullDoc;
  productosSemanales: ProductoSemanalPullDoc;
  pedidos: PedidoPullDoc;
  detallesPedido: DetallePedidoPullDoc;
  estadosPedido: EstadoPedidoPullDoc;
}[C];

// Only advance the checkpoint over contiguous seq prefixes; a gap younger than the grace window
// cuts the batch short (an in-flight transaction may still own the missing seqs), an older gap is
// assumed consumed by a rolled-back transaction and skipped (§4.2).
function cortarEnBrechas(filas: FilaSyncCambio[], checkpoint: bigint): FilaSyncCambio[] {
  const entregadas: FilaSyncCambio[] = [];
  let esperado = checkpoint + 1n;
  for (const fila of filas) {
    if (fila.id === esperado) {
      entregadas.push(fila);
      esperado += 1n;
      continue;
    }
    const edadBrechaMs = Date.now() - fila.creadoEn.getTime();
    if (edadBrechaMs > GAP_WINDOW_MS) {
      entregadas.push(fila);
      esperado = fila.id + 1n;
      continue;
    }
    break;
  }
  return entregadas;
}

interface FilaCatalogoBase {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: Date;
}

interface DocCatalogoBase {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

function aDocCatalogoBase<T extends DocCatalogoBase>(fila: FilaCatalogoBase): T {
  return {
    id: fila.id,
    nombre: fila.nombre,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  } as T;
}

function aDocMunicipio(fila: FilaMunicipio): MunicipioDoc {
  return aDocCatalogoBase<MunicipioDoc>(fila);
}

function aDocLocalidad(fila: FilaLocalidad): LocalidadDoc {
  return {
    id: fila.id,
    fkMunicipio: fila.fkMunicipio,
    nombre: fila.nombre,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

function aDocCategoria(fila: FilaCategoria): CategoriaDoc {
  return aDocCatalogoBase<CategoriaDoc>(fila);
}

function aDocUnidad(fila: FilaUnidad): UnidadDoc {
  return {
    id: fila.id,
    tipo: fila.tipo,
    nombre: fila.nombre,
    abreviatura: fila.abreviatura,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

function aDocProducto(fila: FilaProducto): ProductoDoc {
  return {
    id: fila.id,
    nombre: fila.nombre,
    descripcion: fila.descripcion,
    fkCategoria: fila.fkCategoria,
    fkUnidad: fila.fkUnidad,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

function aDocImagen(fila: FilaImagen): ImagenDoc {
  return {
    id: fila.id,
    fkProducto: fila.fkProducto,
    fkProductoSemanal: fila.fkProductoSemanal,
    storageKey: fila.storageKey,
    url: fila.url,
    orden: fila.orden,
    principal: fila.principal,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

function aDocPublicacion(fila: FilaPublicacion): PublicacionDoc {
  return {
    id: fila.id,
    fkAgricultor: fila.fkAgricultor,
    fechaCiclo: aFechaCiclo(fila.fechaCiclo),
    semanaIso: fila.semanaIso,
    anioIso: fila.anioIso,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: false, // lifecycle varchar never tombstones (database.md §6.3.5)
  };
}

function aDocProductoSemanal(fila: FilaItemSemanal): ProductoSemanalDoc {
  return {
    id: fila.id,
    fkPublicacion: fila.fkPublicacion,
    fkProducto: fila.fkProducto,
    fkUnidad: fila.fkUnidad,
    precio: fila.precio.toFixed(2),
    stock: fila.stock,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: false, // lifecycle varchar never tombstones (database.md §6.3.5)
  };
}

// P0 Pedidos: S1 state catalog — lifecycle rows without soft-delete, delivered whole.
function aDocEstadoPedido(fila: FilaEstadoPedido): EstadoPedidoDoc {
  return {
    id: fila.id,
    nombre: fila.nombre,
    orden: fila.orden,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

// Order header: money snapshots as strings (F-29), estadoNombre as the lifecycle value,
// lines EMBEDDED (§6.2 one-collection grain; they live and die with the order).
function aDocPedido(
  fila: FilaPedido & { estadoPedido: { nombre: string }; detalles: FilaDetallePedido[] },
): PedidoDoc {
  return {
    id: fila.id,
    fkCliente: fila.fkCliente,
    fkVendedor: fila.fkVendedor,
    estadoNombre: fila.estadoPedido.nombre,
    estado: fila.estado,
    subtotal: fila.subtotal.toFixed(2),
    iva: fila.iva.toFixed(2),
    total: fila.total.toFixed(2),
    origen: fila.origen,
    clienteNombre: fila.clienteNombre,
    clienteTelefono: fila.clienteTelefono,
    notas: fila.notas,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    detalles: fila.detalles.map((d) => ({
      id: d.id,
      fkProductoSemanal: d.fkProductoSemanal,
      nombreProducto: d.nombreProducto,
      cantidad: d.cantidad,
      precioUnitario: d.precioUnitario.toFixed(2),
      importe: d.importe.toFixed(2),
    })),
    _deleted: !fila.estado,
  };
}

// Order line doc (server-only `sync.detallesPedido.pull` endpoint for narrow clients;
// the client embeds lines in the pedido doc instead — free RxDB 13-collection cap).
function aDocDetallePedido(fila: FilaDetallePedido): DetallePedidoDoc {
  return {
    id: fila.id,
    fkPedido: fila.fkPedido,
    fkProductoSemanal: fila.fkProductoSemanal,
    nombreProducto: fila.nombreProducto,
    cantidad: fila.cantidad,
    precioUnitario: fila.precioUnitario.toFixed(2),
    importe: fila.importe.toFixed(2),
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: false, // lines have no soft-delete: they live and die with the order
  };
}

// Resolve the CURRENT state of each outbox row's business row; operacion='delete' or a missing row
// yields a minimal tombstone (§4.3). The casts bridge the C↔case correlation TypeScript cannot
// express; each is checked by the switch itself.
//
// `sesion` is only consumed by the `imagenes` case (M-11): semanal images are visible
// under the SAME scoping as their publication (agricultor: own; buyers: published
// current-ciclo items; admin: all) — maestro images keep the global read scope.
async function resolverDocumentos<C extends GlobalColeccion>(
  coleccion: C,
  lote: FilaSyncCambio[],
  db: Database,
  sesion: { esAdmin: boolean; idUsuario: string; rol: string },
): Promise<Array<DocPullDe<C>>> {
  const ids = [...new Set(lote.map((fila) => fila.idFila))];
  switch (coleccion) {
    case "municipios": {
      const filas = await db.municipio.findMany({ where: { id: { in: ids } } });
      const porId = new Map(filas.map((fila) => [fila.id, fila] as const));
      return lote.map((fila): MunicipioPullDoc =>
        fila.operacion === OPERACION.DELETE || !porId.get(fila.idFila)
          ? { id: fila.idFila, _deleted: true }
          : aDocMunicipio(porId.get(fila.idFila) as FilaMunicipio),
      ) as Array<DocPullDe<C>>;
    }
    case "localidades": {
      const filas = await db.localidad.findMany({ where: { id: { in: ids } } });
      const porId = new Map(filas.map((fila) => [fila.id, fila] as const));
      return lote.map((fila): LocalidadPullDoc =>
        fila.operacion === OPERACION.DELETE || !porId.get(fila.idFila)
          ? { id: fila.idFila, _deleted: true }
          : aDocLocalidad(porId.get(fila.idFila) as FilaLocalidad),
      ) as Array<DocPullDe<C>>;
    }
    case "categorias": {
      const filas = await db.categoriaProducto.findMany({
        where: { id: { in: ids } },
      });
      const porId = new Map(filas.map((fila) => [fila.id, fila] as const));
      return lote.map((fila): CategoriaPullDoc =>
        fila.operacion === OPERACION.DELETE || !porId.get(fila.idFila)
          ? { id: fila.idFila, _deleted: true }
          : aDocCategoria(porId.get(fila.idFila) as FilaCategoria),
      ) as Array<DocPullDe<C>>;
    }
    case "unidades": {
      const filas = await db.unidad.findMany({ where: { id: { in: ids } } });
      const porId = new Map(filas.map((fila) => [fila.id, fila] as const));
      return lote.map((fila): UnidadPullDoc =>
        fila.operacion === OPERACION.DELETE || !porId.get(fila.idFila)
          ? { id: fila.idFila, _deleted: true }
          : aDocUnidad(porId.get(fila.idFila) as FilaUnidad),
      ) as Array<DocPullDe<C>>;
    }
    case "productos": {
      const filas = await db.producto.findMany({ where: { id: { in: ids } } });
      const porId = new Map(filas.map((fila) => [fila.id, fila] as const));
      return lote.map((fila): ProductoPullDoc =>
        fila.operacion === OPERACION.DELETE || !porId.get(fila.idFila)
          ? { id: fila.idFila, _deleted: true }
          : aDocProducto(porId.get(fila.idFila) as FilaProducto),
      ) as Array<DocPullDe<C>>;
    }
    case "imagenes": {
      const filas = await db.productoImagen.findMany({
        where: { id: { in: ids } },
        include: {
          productoSemanal: {
            include: {
              publicacion: { select: { fkAgricultor: true, fechaCiclo: true, estado: true } },
            },
          },
        },
      });
      const porId = new Map(filas.map((fila) => [fila.id, fila] as const));
      const cicloActual = mondayOfBusinessWeek(new Date());
      return lote
        .map((fila): ImagenPullDoc | null => {
          if (fila.operacion === OPERACION.DELETE || !porId.get(fila.idFila)) {
            return { id: fila.idFila, _deleted: true };
          }
          const imagen = porId.get(fila.idFila)!;
          if (imagen.fkProductoSemanal) {
            const item = imagen.productoSemanal;
            const pub = item?.publicacion;
            const visible =
              pub != null &&
              (sesion.esAdmin ||
                (sesion.rol === ROLE.AGRICULTOR && pub.fkAgricultor === sesion.idUsuario) ||
                // Buyer lane (Vendedor/Cliente only — Q-19 keeps farmers isolated).
                (sesion.rol !== ROLE.AGRICULTOR &&
                  pub.estado === "publicado" &&
                  pub.fkAgricultor != null &&
                  item?.estado === "activo" &&
                  aFechaCiclo(pub.fechaCiclo) === aFechaCiclo(cicloActual)));
            if (!visible) return null; // filtered out; the outbox row still advances the checkpoint (§4.4)
          }
          return aDocImagen(imagen);
        })
        .filter((doc): doc is ImagenPullDoc => doc !== null) as Array<DocPullDe<C>>;
    }
    case "estadosPedido": {
      // S1 lookup without soft-delete (database.md §6.2): full delivery, no scoping.
      const filas = await db.estadoPedido.findMany({ where: { id: { in: ids } } });
      const porId = new Map(filas.map((fila) => [fila.id, fila] as const));
      return lote.map((fila): EstadoPedidoPullDoc =>
        fila.operacion === OPERACION.DELETE || !porId.get(fila.idFila)
          ? { id: fila.idFila, _deleted: true }
          : aDocEstadoPedido(porId.get(fila.idFila) as FilaEstadoPedido),
      ) as Array<DocPullDe<C>>;
    }
  }
}

function makePullProcedure<C extends GlobalColeccion>(coleccion: C) {
  // Global S1 catalogs are readable by ANY authenticated user (database.md §6.2 global
  // scoping); only authentication is enforced here, no role filter.
  return protectedProcedure
    .input(
      z.object({
        coleccion: z.literal(coleccion),
        checkpoint: z
          .object({ seq: z.number().int().min(0) })
          .nullable()
          .optional(),
        limite: z.number().int().min(5).max(200).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      const checkpoint = BigInt(input.checkpoint?.seq ?? 0);
      const outbox = await ctx.db.syncCambio.findMany({
        where: {
          id: { gt: checkpoint },
          tablaOrigen: TABLA_POR_COLECCION[coleccion],
        },
        orderBy: { id: "asc" },
        take: input.limite + GAP_MARGIN,
      });

      const lote = cortarEnBrechas(outbox, checkpoint).slice(0, input.limite);
      const documentos = await resolverDocumentos(coleccion, lote, ctx.db, {
        esAdmin: ctx.user.rol === ROLE.ADMIN,
        idUsuario: ctx.user.id,
        rol: ctx.user.rol,
      });

      const ultimaFila = lote.at(-1);
      const seqFinal = ultimaFila ? Number(ultimaFila.id) : (input.checkpoint?.seq ?? 0);
      if (!Number.isSafeInteger(seqFinal)) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "sync_cambio seq too large",
        });
      }
      return { documentos, checkpoint: { seq: seqFinal } };
    });
}

// ---- Scoped PULL (P0 Familias, M-9) ----

const GLOBAL_COLECCIONES = [
  "municipios",
  "localidades",
  "categorias",
  "unidades",
  "productos",
  "imagenes",
  "estadosPedido",
] as const;
type GlobalColeccion = (typeof GLOBAL_COLECCIONES)[number];

const SCOPED_COLECCIONES = [
  "familias",
  "membresias",
  "limites_credito",
  "usuarios",
  "publicaciones",
  "productosSemanales",
  "pedidos",
  "detallesPedido",
] as const;
type ScopedColeccion = (typeof SCOPED_COLECCIONES)[number];

function aDocFamiliaScoped(fila: FilaFamilia): FamiliaDoc {
  return {
    id: fila.id,
    nombre: fila.nombre,
    fkJefeUsuario: fila.fkJefeUsuario,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

function aDocMembresiaScoped(fila: FilaMembresia & { usuario: { correo: string } }): MembresiaDoc {
  return {
    id: fila.id,
    fkUsuario: fila.fkUsuario,
    fkFamilia: fila.fkFamilia,
    correo: fila.usuario.correo,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

function aDocLimiteScoped(fila: FilaLimite): LimiteCreditoDoc {
  return {
    id: fila.id,
    monto: fila.monto.toFixed(2),
    fkFamilia: fila.fkFamilia,
    fkUsuario: fila.fkUsuario,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

async function cargarUsuariosCompletos(db: Database, ids: string[]) {
  return db.usuario.findMany({
    where: { id: { in: ids } },
    include: { persona: true, rol: true },
  });
}
type FilaUsuarioCompleta = Awaited<ReturnType<typeof cargarUsuariosCompletos>>[number];

function aDocUsuarioScoped(fila: FilaUsuarioCompleta): UsuarioDoc {
  return {
    id: fila.id,
    correo: fila.correo,
    nombre: fila.persona.nombre,
    apellidoPaterno: fila.persona.apellidoPaterno,
    apellidoMaterno: fila.persona.apellidoMaterno,
    rol: fila.rol.nombre,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

// Outbox sources per scoped collection. For non-admins, membership rows ('familia_usuario')
// ride along in `familias`/`limites_credito` as TRIGGERS: joining a family changes the
// user's visibility retroactively, and their checkpoint already passed that family's own
// outbox rows — the membership row re-delivers the affected family state.
function tablasOutboxDe(coleccion: ScopedColeccion, esAdmin: boolean): string[] {
  switch (coleccion) {
    case "familias":
      return esAdmin ? ["familia"] : ["familia", "familia_usuario"];
    case "membresias":
      return ["familia_usuario"];
    case "limites_credito":
      return esAdmin ? ["limite_credito"] : ["limite_credito", "familia_usuario"];
    case "usuarios":
      // Non-admins also ride membership rows as TRIGGERS: joining a family re-delivers
      // its roster even when the co-members' usuario outbox rows predate the checkpoint.
      return esAdmin ? ["usuario"] : ["usuario", "familia_usuario"];
    case "publicaciones":
      return ["publicacion_semanal"];
    case "productosSemanales":
      return ["producto_semanal"];
    case "pedidos":
      return ["pedido_cabecera"];
    case "detallesPedido":
      return ["detalle_pedido"];
  }
}

async function resolverObjetivosFamiliasMiembro(
  lote: FilaSyncCambio[],
  db: Database,
  idUsuario: string,
): Promise<Map<string, boolean>> {
  const objetivos = new Map<string, boolean>();
  const propias = await db.familiaUsuario.findMany({
    where: { fkUsuario: idUsuario, estado: true },
    select: { fkFamilia: true },
  });
  const misFamilias = new Set(propias.map((p) => p.fkFamilia));
  const idsMembresia = lote.filter((f) => f.tablaOrigen === "familia_usuario").map((f) => f.idFila);
  const filasMembresia = idsMembresia.length
    ? await db.familiaUsuario.findMany({ where: { id: { in: idsMembresia } } })
    : [];
  const membresiasPorId = new Map(filasMembresia.map((m) => [m.id, m]));

  for (const fila of lote) {
    if (fila.tablaOrigen === "familia") {
      if (misFamilias.has(fila.idFila)) objetivos.set(fila.idFila, false);
      continue;
    }
    const membresia = membresiasPorId.get(fila.idFila);
    if (membresia?.fkUsuario === idUsuario) {
      objetivos.set(membresia.fkFamilia, !membresia.estado);
    }
  }
  return objetivos;
}

// Admin → all; member → only their family docs. Own-membership triggers: join delivers
// the family doc; baja delivers a tombstone (the family is no longer the user's).
async function resolverFamiliasScoped(
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
): Promise<FamiliaPullDoc[]> {
  // id → tombstone? (the user left the family → _deleted doc)
  const objetivos = esAdmin
    ? new Map<string, boolean>(lote.map((fila) => [fila.idFila, false]))
    : await resolverObjetivosFamiliasMiembro(lote, db, idUsuario);
  const idsReales = [...objetivos].filter(([, tombstone]) => !tombstone).map(([id]) => id);
  const filas = idsReales.length
    ? await db.familia.findMany({ where: { id: { in: idsReales } } })
    : [];
  const porId = new Map(filas.map((f) => [f.id, f]));
  const documentos = new Map<string, FamiliaPullDoc>();
  for (const [id, tombstone] of objetivos) {
    const fila = !tombstone ? porId.get(id) : undefined;
    documentos.set(id, fila ? aDocFamiliaScoped(fila) : { id, _deleted: true });
  }
  return [...documentos.values()];
}

// Admin → all; member → own membership rows + the CURRENT roster of their active family
// (a co-member row re-delivers the roster, covering members added before the checkpoint).
async function resolverMembresiasScoped(
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
): Promise<MembresiaPullDoc[]> {
  const documentos = new Map<string, MembresiaPullDoc>();
  const ids = [...new Set(lote.map((f) => f.idFila))];
  const filas = ids.length
    ? await db.familiaUsuario.findMany({
        where: { id: { in: ids } },
        include: { usuario: { select: { correo: true } } },
      })
    : [];
  const porId = new Map(filas.map((f) => [f.id, f]));
  const misFamilias = esAdmin
    ? new Set<string>()
    : new Set(
        (
          await db.familiaUsuario.findMany({
            where: { fkUsuario: idUsuario, estado: true },
            select: { fkFamilia: true },
          })
        ).map((p) => p.fkFamilia),
      );
  const rosters = new Set<string>();
  for (const fila of lote) {
    if (fila.operacion === "delete" || !porId.get(fila.idFila)) {
      documentos.set(fila.idFila, { id: fila.idFila, _deleted: true });
      continue;
    }
    const membresia = porId.get(fila.idFila)!;
    if (esAdmin || membresia.fkUsuario === idUsuario) {
      documentos.set(membresia.id, aDocMembresiaScoped(membresia));
    } else if (misFamilias.has(membresia.fkFamilia)) {
      rosters.add(membresia.fkFamilia);
    }
  }
  if (rosters.size > 0) {
    const filasRosters = await db.familiaUsuario.findMany({
      where: { fkFamilia: { in: [...rosters] } },
      include: { usuario: { select: { correo: true } } },
    });
    for (const m of filasRosters) documentos.set(m.id, aDocMembresiaScoped(m));
  }
  return [...documentos.values()];
}

async function resolverObjetivosLimitesMiembro(
  lote: FilaSyncCambio[],
  db: Database,
  idUsuario: string,
): Promise<Map<string, boolean>> {
  const objetivos = new Map<string, boolean>();
  const propias = await db.familiaUsuario.findMany({
    where: { fkUsuario: idUsuario, estado: true },
    select: { fkFamilia: true },
  });
  const misFamilias = new Set(propias.map((p) => p.fkFamilia));
  const idsLimite = lote.filter((f) => f.tablaOrigen === "limite_credito").map((f) => f.idFila);
  const filasLimite = idsLimite.length
    ? await db.limiteCredito.findMany({ where: { id: { in: idsLimite } } })
    : [];
  for (const fila of filasLimite) {
    const visible =
      fila.fkUsuario === idUsuario || (fila.fkFamilia != null && misFamilias.has(fila.fkFamilia));
    if (visible) objetivos.set(fila.id, false);
  }
  const idsMembresia = lote.filter((f) => f.tablaOrigen === "familia_usuario").map((f) => f.idFila);
  const filasMembresia = idsMembresia.length
    ? await db.familiaUsuario.findMany({ where: { id: { in: idsMembresia } } })
    : [];

  const membresiasPropias = filasMembresia.filter((m) => m.fkUsuario === idUsuario);
  if (membresiasPropias.length > 0) {
    const familiasPropias = [...new Set(membresiasPropias.map((m) => m.fkFamilia))];
    const limitesFamilias = await db.limiteCredito.findMany({
      where: { fkFamilia: { in: familiasPropias } },
    });
    const limitePorFamilia = new Map(
      limitesFamilias.filter((l) => l.fkFamilia != null).map((l) => [l.fkFamilia!, l]),
    );
    for (const membresia of membresiasPropias) {
      const limite = limitePorFamilia.get(membresia.fkFamilia);
      if (limite) objetivos.set(limite.id, !membresia.estado);
    }
  }
  return objetivos;
}

// Admin → all; member → their own user limit + their family's limit. Own-membership
// triggers: join delivers the family limit; baja tombstones it (visibility ended).
async function resolverLimitesScoped(
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
): Promise<LimiteCreditoPullDoc[]> {
  const objetivos = esAdmin
    ? new Map<string, boolean>(lote.map((fila) => [fila.idFila, false]))
    : await resolverObjetivosLimitesMiembro(lote, db, idUsuario);

  const idsReales = [...objetivos].filter(([, tombstone]) => !tombstone).map(([id]) => id);
  const filas = idsReales.length
    ? await db.limiteCredito.findMany({ where: { id: { in: idsReales } } })
    : [];
  const porId = new Map(filas.map((f) => [f.id, f]));
  const documentos = new Map<string, LimiteCreditoPullDoc>();
  for (const [id, tombstone] of objetivos) {
    const fila = !tombstone ? porId.get(id) : undefined;
    documentos.set(id, fila ? aDocLimiteScoped(fila) : { id, _deleted: true });
  }
  return [...documentos.values()];
}

async function resolverUsuariosAdmin(
  lote: FilaSyncCambio[],
  db: Database,
): Promise<UsuarioPullDoc[]> {
  const ids = [...new Set(lote.map((f) => f.idFila))];
  const filas = await cargarUsuariosCompletos(db, ids);
  const porId = new Map(filas.map((f) => [f.id, f]));
  const documentos = new Map<string, UsuarioPullDoc>();
  for (const fila of lote) {
    const u = porId.get(fila.idFila);
    documentos.set(
      fila.idFila,
      fila.operacion === OPERACION.DELETE || !u
        ? { id: fila.idFila, _deleted: true }
        : aDocUsuarioScoped(u),
    );
  }
  return [...documentos.values()];
}

async function procesarTriggersMembresiaUsuarios(
  lote: FilaSyncCambio[],
  db: Database,
  idUsuario: string,
  misFamilias: string[],
  visibles: Set<string>,
  documentos: Map<string, UsuarioPullDoc>,
): Promise<void> {
  const idsMembresia = lote.filter((f) => f.tablaOrigen === "familia_usuario").map((f) => f.idFila);
  const filasMembresia = idsMembresia.length
    ? await db.familiaUsuario.findMany({ where: { id: { in: idsMembresia } } })
    : [];

  const familiasReentregaRoster = new Set<string>();
  const usuariosParaCargar = new Set<string>();

  for (const membresia of filasMembresia) {
    if (!misFamilias.includes(membresia.fkFamilia)) continue;
    if (membresia.fkUsuario === idUsuario) {
      familiasReentregaRoster.add(membresia.fkFamilia);
    } else if (membresia.estado && visibles.has(membresia.fkUsuario)) {
      usuariosParaCargar.add(membresia.fkUsuario);
    } else if (!membresia.estado) {
      documentos.set(membresia.fkUsuario, { id: membresia.fkUsuario, _deleted: true });
    }
  }

  if (familiasReentregaRoster.size > 0) {
    const roster = await db.familiaUsuario.findMany({
      where: { fkFamilia: { in: [...familiasReentregaRoster] }, estado: true },
      select: { fkUsuario: true },
    });
    for (const r of roster) {
      usuariosParaCargar.add(r.fkUsuario);
    }
  }

  if (usuariosParaCargar.size > 0) {
    const filasUsuarios = await cargarUsuariosCompletos(db, [...usuariosParaCargar]);
    for (const u of filasUsuarios) {
      documentos.set(u.id, aDocUsuarioScoped(u));
    }
  }
}

// Admin → all; non-admin → self + the members of their own active family (§6.2
// `usuarios` scoping). Own-membership triggers re-deliver the CURRENT roster (covers
// co-members whose usuario outbox rows predate the checkpoint); a co-member's baja
// tombstones them (their visibility ended), mirroring the familias resolver.
async function resolverUsuariosScoped(
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
): Promise<UsuarioPullDoc[]> {
  if (esAdmin) {
    return resolverUsuariosAdmin(lote, db);
  }

  const documentos = new Map<string, UsuarioPullDoc>();
  const propias = await db.familiaUsuario.findMany({
    where: { fkUsuario: idUsuario, estado: true },
    select: { fkFamilia: true },
  });
  const misFamilias = propias.map((p) => p.fkFamilia);
  const membresiasFamilia = misFamilias.length
    ? await db.familiaUsuario.findMany({
        where: { fkFamilia: { in: misFamilias } },
        select: { fkUsuario: true, estado: true },
      })
    : [];
  const visibles = new Set<string>([idUsuario]);
  for (const m of membresiasFamilia) {
    if (m.estado) visibles.add(m.fkUsuario);
  }

  // Batch rows straight from the usuario outbox: deliver only what the identity sees.
  const idsUsuario = lote
    .filter((f) => f.tablaOrigen === "usuario" && visibles.has(f.idFila))
    .map((f) => f.idFila);
  const filas = await cargarUsuariosCompletos(db, idsUsuario);
  const porId = new Map(filas.map((f) => [f.id, f]));
  for (const id of idsUsuario) {
    const u = porId.get(id);
    if (u) documentos.set(id, aDocUsuarioScoped(u));
  }

  await procesarTriggersMembresiaUsuarios(lote, db, idUsuario, misFamilias, visibles, documentos);
  return [...documentos.values()];
}

// P0 Publicaciones (Q-25/§6.2): admin → all; Agricultor → own (all weeks, every state);
// Vendedor/Cliente (buyers) → estado='publicado' of the CURRENT ciclo only. Invisible
// rows still advance the checkpoint (§4.4). Trade-off (documented): a mid-week
// publicado→cerrado transition stops being delivered to buyers — their local doc keeps
// the last pulled state until the ciclo changes; availability enforcement is the
// pedidos module's server-side job.
async function resolverPublicacionesScoped(
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
  rol: string,
): Promise<PublicacionPullDoc[]> {
  const ids = [...new Set(lote.map((f) => f.idFila))];
  const filas = await db.publicacionSemanal.findMany({ where: { id: { in: ids } } });
  const porId = new Map(filas.map((f) => [f.id, f]));
  const cicloActual = aFechaCiclo(mondayOfBusinessWeek(new Date()));
  const documentos = new Map<string, PublicacionPullDoc>();
  for (const fila of lote) {
    const pub = porId.get(fila.idFila);
    if (fila.operacion === OPERACION.DELETE || !pub) {
      // Hard deletes are admin-owned events; only their owner (or admin) gets the tombstone.
      if (esAdmin || pub?.fkAgricultor === idUsuario) {
        documentos.set(fila.idFila, { id: fila.idFila, _deleted: true });
      }
      continue;
    }
    if (esAdmin || (rol === ROLE.AGRICULTOR && pub.fkAgricultor === idUsuario)) {
      documentos.set(pub.id, aDocPublicacion(pub));
      continue;
    }
    // Buyer lane applies to Vendedor/Cliente ONLY — another Agricultor's offers are
    // invisible (each farmer manages its own cycle; Q-19).
    if (
      rol !== ROLE.AGRICULTOR &&
      pub.estado === ESTADO_PUBLICACION.PUBLICADO &&
      pub.fkAgricultor != null &&
      aFechaCiclo(pub.fechaCiclo) === cicloActual
    ) {
      documentos.set(pub.id, aDocPublicacion(pub));
    }
  }
  return [...documentos.values()];
}

// Weekly items: admin → all; Agricultor → items of own publications (every state);
// buyers → 'activo' items of published current-ciclo publications.
async function resolverItemsSemanalesScoped(
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
  rol: string,
): Promise<ProductoSemanalPullDoc[]> {
  const ids = [...new Set(lote.map((f) => f.idFila))];
  const filas = await db.productoSemanal.findMany({
    where: { id: { in: ids } },
    include: { publicacion: { select: { fkAgricultor: true, fechaCiclo: true, estado: true } } },
  });
  const porId = new Map(filas.map((f) => [f.id, f]));
  const cicloActual = aFechaCiclo(mondayOfBusinessWeek(new Date()));
  const documentos = new Map<string, ProductoSemanalPullDoc>();
  for (const fila of lote) {
    const item = porId.get(fila.idFila);
    if (fila.operacion === OPERACION.DELETE || !item) {
      if (esAdmin || item?.publicacion.fkAgricultor === idUsuario) {
        documentos.set(fila.idFila, { id: fila.idFila, _deleted: true });
      }
      continue;
    }
    const pub = item.publicacion;
    if (esAdmin || (rol === ROLE.AGRICULTOR && pub.fkAgricultor === idUsuario)) {
      documentos.set(item.id, aDocProductoSemanal(item));
      continue;
    }
    // Buyer lane applies to Vendedor/Cliente ONLY (Q-19: farmers see only their own).
    if (
      rol !== ROLE.AGRICULTOR &&
      pub.estado === ESTADO_PUBLICACION.PUBLICADO &&
      pub.fkAgricultor != null &&
      item.estado === ESTADO_ITEM_SEMANAL.ACTIVO &&
      aFechaCiclo(pub.fechaCiclo) === cicloActual
    ) {
      documentos.set(item.id, aDocProductoSemanal(item));
    }
  }
  return [...documentos.values()];
}

// P0 Pedidos (§6.2 `pedidos` scoping): admin → all; Cliente → own; Vendedor → assigned
// to them. Agricultores don't participate in pedidos (legacy HasRole parity).
function visiblePedido(
  rol: string,
  idUsuario: string,
  fkCliente: string | null,
  fkVendedor: string | null,
): boolean {
  if (rol === ROLE.ADMIN) return true;
  if (rol === ROLE.VENDEDOR) return fkVendedor === idUsuario;
  if (rol === ROLE.CLIENTE) return fkCliente === idUsuario;
  return false;
}

async function resolverPedidosScoped(
  lote: FilaSyncCambio[],
  db: Database,
  idUsuario: string,
  rol: string,
): Promise<PedidoPullDoc[]> {
  const ids = [...new Set(lote.map((f) => f.idFila))];
  const filas = await db.pedidoCabecera.findMany({
    where: { id: { in: ids } },
    include: { estadoPedido: { select: { nombre: true } }, detalles: true },
  });
  const porId = new Map(filas.map((f) => [f.id, f] as const));
  const documentos: PedidoPullDoc[] = [];
  for (const fila of lote) {
    const pedido = porId.get(fila.idFila);
    if (fila.operacion === OPERACION.DELETE || !pedido?.estado) {
      // A soft-deleted order tombstones for its owner scope only.
      if (pedido && visiblePedido(rol, idUsuario, pedido.fkCliente, pedido.fkVendedor)) {
        documentos.push({ id: fila.idFila, _deleted: true });
      }
      continue;
    }
    if (visiblePedido(rol, idUsuario, pedido.fkCliente, pedido.fkVendedor)) {
      documentos.push(aDocPedido(pedido));
    }
  }
  return documentos;
}

// Order lines ride the PARENT order's visibility (§6.2: "junto a pedidos").
async function resolverDetallesScoped(
  lote: FilaSyncCambio[],
  db: Database,
  idUsuario: string,
  rol: string,
): Promise<DetallePedidoPullDoc[]> {
  const ids = [...new Set(lote.map((f) => f.idFila))];
  const filas = await db.detallePedido.findMany({
    where: { id: { in: ids } },
    include: { pedido: { include: { estadoPedido: { select: { nombre: true } } } } },
  });
  const porId = new Map(filas.map((f) => [f.id, f] as const));
  const documentos: DetallePedidoPullDoc[] = [];
  for (const fila of lote) {
    const detalle = porId.get(fila.idFila);
    const pedido = detalle?.pedido;
    if (fila.operacion === OPERACION.DELETE || !detalle || !pedido?.estado) {
      if (pedido && visiblePedido(rol, idUsuario, pedido.fkCliente, pedido.fkVendedor)) {
        documentos.push({ id: fila.idFila, _deleted: true });
      }
      continue;
    }
    if (visiblePedido(rol, idUsuario, pedido.fkCliente, pedido.fkVendedor)) {
      documentos.push(aDocDetallePedido(detalle));
    }
  }
  return documentos;
}

async function resolverScoped<C extends ScopedColeccion>(
  coleccion: C,
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
  rol: string,
): Promise<Array<DocPullDe<C>>> {
  switch (coleccion) {
    case "familias":
      return (await resolverFamiliasScoped(lote, db, esAdmin, idUsuario)) as Array<DocPullDe<C>>;
    case "membresias":
      return (await resolverMembresiasScoped(lote, db, esAdmin, idUsuario)) as Array<DocPullDe<C>>;
    case "limites_credito":
      return (await resolverLimitesScoped(lote, db, esAdmin, idUsuario)) as Array<DocPullDe<C>>;
    case "usuarios":
      return (await resolverUsuariosScoped(lote, db, esAdmin, idUsuario)) as Array<DocPullDe<C>>;
    case "publicaciones":
      return (await resolverPublicacionesScoped(lote, db, esAdmin, idUsuario, rol)) as Array<
        DocPullDe<C>
      >;
    case "productosSemanales":
      return (await resolverItemsSemanalesScoped(lote, db, esAdmin, idUsuario, rol)) as Array<
        DocPullDe<C>
      >;
    case "pedidos":
      return (await resolverPedidosScoped(lote, db, idUsuario, rol)) as Array<DocPullDe<C>>;
    case "detallesPedido":
      return (await resolverDetallesScoped(lote, db, idUsuario, rol)) as Array<DocPullDe<C>>;
  }
}

// Same PULL contract as the global factory (§4), but the batch selection and the
// resolution apply the §11 role+family scoping on every call.
function makeScopedPullProcedure<C extends ScopedColeccion>(coleccion: C) {
  return protectedProcedure
    .input(
      z.object({
        coleccion: z.literal(coleccion),
        checkpoint: z
          .object({ seq: z.number().int().min(0) })
          .nullable()
          .optional(),
        limite: z.number().int().min(5).max(200).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      const esAdmin = ctx.user.rol === ROLE.ADMIN;
      const checkpoint = BigInt(input.checkpoint?.seq ?? 0);
      const outbox = await ctx.db.syncCambio.findMany({
        where: {
          id: { gt: checkpoint },
          tablaOrigen: { in: tablasOutboxDe(coleccion, esAdmin) },
        },
        orderBy: { id: "asc" },
        take: input.limite + GAP_MARGIN,
      });

      const lote = cortarEnBrechas(outbox, checkpoint).slice(0, input.limite);
      const documentos = await resolverScoped(
        coleccion,
        lote,
        ctx.db,
        esAdmin,
        ctx.user.id,
        ctx.user.rol,
      );

      const ultimaFila = lote.at(-1);
      const seqFinal = ultimaFila ? Number(ultimaFila.id) : (input.checkpoint?.seq ?? 0);
      if (!Number.isSafeInteger(seqFinal)) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "sync_cambio seq too large",
        });
      }
      return { documentos, checkpoint: { seq: seqFinal } };
    });
}

// ---- PUSH (§5) — slice scope: localidades only (§14) ----

const operacionPushSchema = z.object({
  operationId: z.uuid(),
  docId: z.uuid(),
  op: z.enum(["create", "update", "delete"]),
  nuevoEstado: z.object({
    fkMunicipio: z.uuid(),
    nombre: z.string().min(1),
    estado: z.boolean().optional(),
    _deleted: z.boolean().optional(),
  }),
  versionAsumida: z.number().int().positive().nullable(),
});
type OperacionPushInput = z.infer<typeof operacionPushSchema>;

type RespuestaOperacion = {
  motivo?: string;
  estadoServidor?: unknown;
};

function tombstoneLocalidad(operacion: OperacionPushInput): LocalidadPullDoc {
  // §5.1 — a rejected create without a server row synthesizes a tombstone so the client's
  // server-wins conflictHandler removes the local document instead of leaving a ghost.
  return { ...operacion.nuevoEstado, id: operacion.docId, _deleted: true };
}

function registrarOperacion(
  tx: Prisma.TransactionClient,
  coleccion: Coleccion,
  // Collection-agnostic operation shape: the idempotency registry stores the common
  // fields; collection-specific payloads live in `respuesta` (jsonb).
  operacion: { operationId: string; docId: string; op: string },
  idUsuario: string,
  veredicto: Veredicto,
  respuesta: RespuestaOperacion | null,
): Promise<unknown> {
  return tx.syncOperacion.create({
    data: {
      id: operacion.operationId,
      fkUsuario: idUsuario,
      coleccion,
      docId: operacion.docId,
      op: operacion.op,
      veredicto,
      // aplicada preserves nothing (§7); the value is JSON by construction, hence the cast.
      respuesta: (respuesta ?? {}) as unknown as Prisma.InputJsonValue,
    },
  });
}

function veredictoAlmacenado(fila: FilaSyncOperacion): ResultadoPush {
  const respuesta = (fila.respuesta ?? {}) as RespuestaOperacion;
  const resultado: ResultadoPush = {
    operationId: fila.id,
    docId: fila.docId,
    // Stored values are always this module's own VEREDICTO constants.
    veredicto: fila.veredicto as Veredicto,
  };
  if (respuesta.motivo !== undefined) resultado.motivo = respuesta.motivo;
  if (respuesta.estadoServidor !== undefined) resultado.estadoServidor = respuesta.estadoServidor;
  return resultado;
}
async function aplicarCreateLocalidad(
  tx: Prisma.TransactionClient,
  operacion: OperacionPushInput,
  idUsuario: string,
  actual: FilaLocalidad | null,
  estadoFila: boolean,
  base: { operationId: string; docId: string },
): Promise<ResultadoPush> {
  // §5.2 step 4 — create requires a nonexistent row; otherwise conflict with real state.
  if (actual) {
    const estadoServidor = aDocLocalidad(actual);
    await registrarOperacion(tx, "localidades", operacion, idUsuario, VEREDICTO.CONFLICTO, {
      estadoServidor,
    });
    return { ...base, veredicto: VEREDICTO.CONFLICTO, estadoServidor };
  }
  // Domain rule before the version check (§5.2 steps 3–4).
  const municipio = await tx.municipio.findUnique({
    where: { id: operacion.nuevoEstado.fkMunicipio },
  });
  if (!municipio) {
    const estadoServidor = tombstoneLocalidad(operacion);
    const motivo = "fkMunicipio does not exist";
    await registrarOperacion(tx, "localidades", operacion, idUsuario, VEREDICTO.RECHAZADA, {
      motivo,
      estadoServidor,
    });
    return {
      ...base,
      veredicto: VEREDICTO.RECHAZADA,
      motivo,
      estadoServidor,
    };
  }
  await tx.localidad.create({
    data: {
      id: operacion.docId,
      fkMunicipio: operacion.nuevoEstado.fkMunicipio,
      nombre: operacion.nuevoEstado.nombre,
      estado: estadoFila,
      version: 1,
    },
  });
  await tx.syncCambio.create({
    data: {
      tablaOrigen: "localidad",
      idFila: operacion.docId,
      operacion: "insert",
      actor: idUsuario,
    },
  });
  await registrarOperacion(tx, "localidades", operacion, idUsuario, VEREDICTO.APLICADA, null);
  return { ...base, veredicto: VEREDICTO.APLICADA };
}

async function aplicarUpdateODeleteLocalidad(
  tx: Prisma.TransactionClient,
  operacion: OperacionPushInput,
  idUsuario: string,
  actual: FilaLocalidad | null,
  estadoFila: boolean,
  base: { operationId: string; docId: string },
): Promise<ResultadoPush> {
  if (!actual) {
    if (operacion.op === OPERACION.DELETE) {
      // Deleting a row that never existed server-side already achieves the end state.
      const motivo = "delete of a nonexistent row; no-op";
      await registrarOperacion(tx, "localidades", operacion, idUsuario, VEREDICTO.APLICADA, {
        motivo,
      });
      return { ...base, veredicto: VEREDICTO.APLICADA, motivo };
    }
    const estadoServidor = tombstoneLocalidad(operacion);
    const motivo = "row does not exist on the server";
    await registrarOperacion(tx, "localidades", operacion, idUsuario, VEREDICTO.RECHAZADA, {
      motivo,
      estadoServidor,
    });
    return {
      ...base,
      veredicto: VEREDICTO.RECHAZADA,
      motivo,
      estadoServidor,
    };
  }

  // Domain rule before the version check (§5.2 steps 3–4).
  if (operacion.op === OPERACION.UPDATE) {
    const municipio = await tx.municipio.findUnique({
      where: { id: operacion.nuevoEstado.fkMunicipio },
    });
    if (!municipio) {
      const estadoServidor = aDocLocalidad(actual);
      const motivo = "fkMunicipio does not exist";
      await registrarOperacion(tx, "localidades", operacion, idUsuario, VEREDICTO.RECHAZADA, {
        motivo,
        estadoServidor,
      });
      return {
        ...base,
        veredicto: VEREDICTO.RECHAZADA,
        motivo,
        estadoServidor,
      };
    }
  }
  if (operacion.versionAsumida === null) {
    const estadoServidor = aDocLocalidad(actual);
    await registrarOperacion(tx, "localidades", operacion, idUsuario, VEREDICTO.CONFLICTO, {
      estadoServidor,
    });
    return { ...base, veredicto: VEREDICTO.CONFLICTO, estadoServidor };
  }

  // §5.2 steps 4–5 — atomic compare-and-set on the server version (SP-2).
  const aplicadas = await tx.localidad.updateMany({
    where: { id: operacion.docId, version: operacion.versionAsumida },
    data: {
      nombre: operacion.nuevoEstado.nombre,
      fkMunicipio: operacion.nuevoEstado.fkMunicipio,
      estado: estadoFila,
      version: { increment: 1 },
    },
  });
  if (aplicadas.count === 0) {
    const servidor = await tx.localidad.findUnique({
      where: { id: operacion.docId },
    });
    const estadoServidor = servidor ? aDocLocalidad(servidor) : tombstoneLocalidad(operacion);
    await registrarOperacion(tx, "localidades", operacion, idUsuario, VEREDICTO.CONFLICTO, {
      estadoServidor,
    });
    return { ...base, veredicto: VEREDICTO.CONFLICTO, estadoServidor };
  }
  // Soft-delete conserves the row and records 'update' in the outbox (§8); clients never
  // decide physical deletions (database.md §6.3.6).
  await tx.syncCambio.create({
    data: {
      tablaOrigen: "localidad",
      idFila: operacion.docId,
      operacion: "update",
      actor: idUsuario,
    },
  });
  await registrarOperacion(tx, "localidades", operacion, idUsuario, VEREDICTO.APLICADA, null);
  return { ...base, veredicto: VEREDICTO.APLICADA };
}

async function aplicarOperacionLocalidad(
  db: Database,
  idUsuario: string,
  operacion: OperacionPushInput,
): Promise<ResultadoPush> {
  const base = { operationId: operacion.operationId, docId: operacion.docId };
  try {
    return await db.$transaction(async (tx) => {
      // §5.2 step 2 — idempotency: a replay returns the stored verdict without re-executing.
      const previa = await tx.syncOperacion.findUnique({
        where: { id: operacion.operationId },
      });
      if (previa) return veredictoAlmacenado(previa);

      const actual = await tx.localidad.findUnique({
        where: { id: operacion.docId },
      });
      // The row's estado mirrors the tombstone flag; _deleted wins when they disagree (§6.3.5).
      const estadoFila =
        operacion.op === OPERACION.DELETE || operacion.nuevoEstado._deleted === true
          ? false
          : (operacion.nuevoEstado.estado ?? true);

      if (operacion.op === OPERACION.CREATE) {
        return aplicarCreateLocalidad(tx, operacion, idUsuario, actual, estadoFila, base);
      }
      return aplicarUpdateODeleteLocalidad(tx, operacion, idUsuario, actual, estadoFila, base);
    });
  } catch (error) {
    // §5.2 step 2 — idempotency race: a concurrent push committed this operationId; its stored
    // verdict is authoritative. Any other failure rethrows (retry is safe: effects rolled back).
    const previa = await db.syncOperacion.findUnique({
      where: { id: operacion.operationId },
    });
    if (previa) return veredictoAlmacenado(previa);
    throw error;
  }
}

// ---- PUSH (§5) — P0 Publicaciones: the FIRST real S2 push class beyond localidades ----
//
// Lane rules (docs/synchronization.md §9 + database.md §6.2 `publicaciones` row):
// - DRAFTS replicate: farmers push estado='borrador' docs (create/update); the server
//   revalidates every domain rule (ownership, ciclo=Monday, maestro active, precio/stock).
// - State transitions (publicar/cancelar/cerrar) are ONLINE-CONFIRM tRPC mutations — a
//   pushed doc with any other estado is 'rechazada' ("se confirma solo en línea").
// - Hard deletes never originate from clients: lifecycle changes are normal updates.

const FECHA_CICLO_PUSH = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Money as decimal string (F-29): digits, optional 1–2 decimals — never float.
const PRECIO_PUSH = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/);

const operacionPublicacionPushSchema = z.object({
  operationId: z.uuid(),
  docId: z.uuid(),
  op: z.enum(["create", "update", "delete"]),
  // fkAgricultor/semanaIso/anioIso are server-owned: stripped here (the server binds the
  // owner to the authenticated identity and derives the ISO week from fechaCiclo).
  nuevoEstado: z.object({
    fechaCiclo: FECHA_CICLO_PUSH,
    estado: z.string(),
    _deleted: z.boolean().optional(),
  }),
  versionAsumida: z.number().int().positive().nullable(),
});
type OperacionPublicacionPush = z.infer<typeof operacionPublicacionPushSchema>;

const operacionItemSemanalPushSchema = z.object({
  operationId: z.uuid(),
  docId: z.uuid(),
  op: z.enum(["create", "update", "delete"]),
  nuevoEstado: z.object({
    fkPublicacion: z.uuid(),
    fkProducto: z.uuid(),
    // Optional: inherits the maestro producto's unidad when absent (NOT NULL in DB).
    fkUnidad: z.uuid().optional(),
    precio: PRECIO_PUSH,
    stock: z.number().int().min(0),
    estado: z.enum(["activo", "inactivo"]),
    _deleted: z.boolean().optional(),
  }),
  versionAsumida: z.number().int().positive().nullable(),
});
type OperacionItemSemanalPush = z.infer<typeof operacionItemSemanalPushSchema>;

function tombstoneDe<TDoc>(operacion: {
  docId: string;
  nuevoEstado: Record<string, unknown>;
}): TDoc {
  // §5.1 tombstone for a rejected create (server-wins removes the local ghost).
  return { ...operacion.nuevoEstado, id: operacion.docId, _deleted: true } as TDoc;
}

async function aplicarCreatePublicacion(
  tx: Prisma.TransactionClient,
  operacion: OperacionPublicacionPush,
  idUsuario: string,
  actual: FilaPublicacion | null,
  base: { operationId: string; docId: string },
  rechazar: (motivo: string, estadoServidor: unknown) => Promise<ResultadoPush>,
  conflicto: (estadoServidor: unknown) => Promise<ResultadoPush>,
): Promise<ResultadoPush> {
  const nuevo = operacion.nuevoEstado;
  // §5.2 step 4 — create requires a nonexistent row; otherwise conflict.
  if (actual) {
    return conflicto(aDocPublicacion(actual));
  }
  // Q-25 uniqueness by (agricultor, fecha de ciclo) — pre-checked so the verdict is
  // a clean 'rechazada' with motivo instead of a raw P2002 failure. CANCELLED rows
  // free the ciclo (legacy blocked re-creation forever after a cancel — a defect we
  // do not inherit; the partial unique excludes 'cancelado' for the same reason).
  const duplicada = await tx.publicacionSemanal.findFirst({
    where: {
      fkAgricultor: idUsuario,
      fechaCiclo: parseFechaCiclo(nuevo.fechaCiclo),
      estado: { not: ESTADO_PUBLICACION.CANCELADO },
    },
    select: { id: true },
  });
  if (duplicada) {
    return rechazar(
      `Ya existe una publicación para el ciclo del ${nuevo.fechaCiclo}`,
      tombstoneDe<PublicacionPullDoc>(operacion),
    );
  }
  const { semanaIso, anioIso } = isoWeekFromMonday(parseFechaCiclo(nuevo.fechaCiclo));
  try {
    await tx.publicacionSemanal.create({
      data: {
        id: operacion.docId,
        fkAgricultor: idUsuario,
        fechaCiclo: parseFechaCiclo(nuevo.fechaCiclo),
        semanaIso,
        anioIso,
        estado: ESTADO_PUBLICACION.BORRADOR,
        version: 1,
      },
    });
  } catch (error) {
    // Concurrent same-ciclo create raced past the pre-check: the partial unique
    // rejects it — surface as a clean rechazada (retry-safe: verdict is persisted).
    if ((error as { code?: string }).code === "P2002") {
      return rechazar(
        `Ya existe una publicación para el ciclo del ${nuevo.fechaCiclo}`,
        tombstoneDe<PublicacionPullDoc>(operacion),
      );
    }
    throw error;
  }
  await tx.syncCambio.create({
    data: {
      tablaOrigen: "publicacion_semanal",
      idFila: operacion.docId,
      operacion: "insert",
      actor: idUsuario,
    },
  });
  await registrarOperacion(tx, "publicaciones", operacion, idUsuario, VEREDICTO.APLICADA, null);
  return { ...base, veredicto: VEREDICTO.APLICADA };
}

async function aplicarUpdatePublicacion(
  tx: Prisma.TransactionClient,
  operacion: OperacionPublicacionPush,
  idUsuario: string,
  actual: FilaPublicacion | null,
  base: { operationId: string; docId: string },
  rechazar: (motivo: string, estadoServidor: unknown) => Promise<ResultadoPush>,
  conflicto: (estadoServidor: unknown) => Promise<ResultadoPush>,
): Promise<ResultadoPush> {
  const nuevo = operacion.nuevoEstado;
  // update — a draft's editable surface is empty (ciclo immovable, estado fixed):
  // the update only rides the version CAS (protocol-completeness for stale clients).
  if (!actual) {
    return rechazar(
      "La publicación no existe en el servidor",
      tombstoneDe<PublicacionPullDoc>(operacion),
    );
  }
  if (actual.fkAgricultor !== idUsuario) {
    return rechazar("La publicación no es tuya", aDocPublicacion(actual));
  }
  if (actual.estado !== ESTADO_PUBLICACION.BORRADOR) {
    return rechazar(
      "Solo los borradores pueden editarse; la confirmación es en línea",
      aDocPublicacion(actual),
    );
  }
  if (aFechaCiclo(actual.fechaCiclo) !== nuevo.fechaCiclo) {
    return rechazar("El ciclo de una publicación no puede modificarse", aDocPublicacion(actual));
  }
  if (operacion.versionAsumida === null) {
    return conflicto(aDocPublicacion(actual));
  }
  const aplicadas = await tx.publicacionSemanal.updateMany({
    where: { id: operacion.docId, version: operacion.versionAsumida },
    data: { version: { increment: 1 } },
  });
  if (aplicadas.count === 0) {
    const servidor = await tx.publicacionSemanal.findUnique({ where: { id: operacion.docId } });
    return conflicto(
      servidor ? aDocPublicacion(servidor) : { id: operacion.docId, _deleted: true },
    );
  }
  await tx.syncCambio.create({
    data: {
      tablaOrigen: "publicacion_semanal",
      idFila: operacion.docId,
      operacion: "update",
      actor: idUsuario,
    },
  });
  await registrarOperacion(tx, "publicaciones", operacion, idUsuario, VEREDICTO.APLICADA, null);
  return { ...base, veredicto: VEREDICTO.APLICADA };
}

async function aplicarOperacionPublicacion(
  db: Database,
  idUsuario: string,
  operacion: OperacionPublicacionPush,
): Promise<ResultadoPush> {
  const base = { operationId: operacion.operationId, docId: operacion.docId };
  try {
    return await db.$transaction(async (tx) => {
      // §5.2 step 2 — idempotency: a replay returns the stored verdict.
      const previa = await tx.syncOperacion.findUnique({ where: { id: operacion.operationId } });
      if (previa) return veredictoAlmacenado(previa);

      // Every verdict (aplicada/conflicto/rechazada) is persisted in the SAME tx (§7),
      // so a retry returns the stored verdict without re-executing effects.
      const rechazar = async (motivo: string, estadoServidor: unknown): Promise<ResultadoPush> => {
        await registrarOperacion(tx, "publicaciones", operacion, idUsuario, VEREDICTO.RECHAZADA, {
          motivo,
          estadoServidor,
        });
        return { ...base, veredicto: VEREDICTO.RECHAZADA, motivo, estadoServidor };
      };
      const conflicto = async (estadoServidor: unknown): Promise<ResultadoPush> => {
        await registrarOperacion(tx, "publicaciones", operacion, idUsuario, VEREDICTO.CONFLICTO, {
          estadoServidor,
        });
        return { ...base, veredicto: VEREDICTO.CONFLICTO, estadoServidor };
      };

      const nuevo = operacion.nuevoEstado;
      if (nuevo.estado !== ESTADO_PUBLICACION.BORRADOR) {
        // §9: state transitions never travel as raw push documents.
        return rechazar(
          "La publicación se confirma solo en línea (publicar/cancelar/cerrar)",
          tombstoneDe<PublicacionPullDoc>(operacion),
        );
      }
      if (operacion.op === "delete") {
        const actualDel = await tx.publicacionSemanal.findUnique({
          where: { id: operacion.docId },
        });
        if (!actualDel) {
          // Deleting a row that never existed server-side already achieves the end state
          // (localidades parity): no-op aplicada keeps orphan cleanups convergent.
          const motivo = "delete de fila inexistente; no-op";
          await registrarOperacion(tx, "publicaciones", operacion, idUsuario, VEREDICTO.APLICADA, {
            motivo,
          });
          return { ...base, veredicto: VEREDICTO.APLICADA, motivo };
        }
        return rechazar(
          "Las publicaciones no se eliminan físicamente; usa cancelar en línea",
          aDocPublicacion(actualDel),
        );
      }
      if (!esLunesFecha(nuevo.fechaCiclo)) {
        return rechazar(
          "La fecha de ciclo debe ser un lunes (ISO 8601)",
          tombstoneDe<PublicacionPullDoc>(operacion),
        );
      }

      const actual = await tx.publicacionSemanal.findUnique({ where: { id: operacion.docId } });

      if (operacion.op === "create") {
        return aplicarCreatePublicacion(
          tx,
          operacion,
          idUsuario,
          actual,
          base,
          rechazar,
          conflicto,
        );
      }

      return aplicarUpdatePublicacion(tx, operacion, idUsuario, actual, base, rechazar, conflicto);
    });
  } catch (error) {
    // §5.2 step 2 — idempotency race: a concurrent push committed this operationId.
    const previa = await db.syncOperacion.findUnique({ where: { id: operacion.operationId } });
    if (previa) return veredictoAlmacenado(previa);
    throw error;
  }
}

async function aplicarCreateItemSemanal(
  tx: Prisma.TransactionClient,
  operacion: OperacionItemSemanalPush,
  idUsuario: string,
  base: { operationId: string; docId: string },
  rechazar: (motivo: string, estadoServidor: unknown) => Promise<ResultadoPush>,
): Promise<ResultadoPush> {
  const nuevo = operacion.nuevoEstado;
  const producto = await tx.producto.findUnique({ where: { id: nuevo.fkProducto } });
  // A pushed item referencing a deactivated maestro → rechazada with motivo.
  if (!producto?.estado) {
    return rechazar(
      "El producto maestro no existe o está inactivo",
      tombstoneDe<ProductoSemanalPullDoc>(operacion),
    );
  }
  const fkUnidad = nuevo.fkUnidad ?? producto.fkUnidad;
  if (!fkUnidad) {
    return rechazar("La unidad es requerida", tombstoneDe<ProductoSemanalPullDoc>(operacion));
  }
  const unidad = await tx.unidad.findUnique({
    where: { id: fkUnidad },
    select: { estado: true },
  });
  if (!unidad?.estado) {
    return rechazar(
      "La unidad indicada no existe o está inactiva",
      tombstoneDe<ProductoSemanalPullDoc>(operacion),
    );
  }
  // M-11: at most one ACTIVE offer per (publicación, producto).
  const duplicado = await tx.productoSemanal.findFirst({
    where: {
      fkPublicacion: nuevo.fkPublicacion,
      fkProducto: nuevo.fkProducto,
      estado: ESTADO_ITEM_SEMANAL.ACTIVO,
    },
    select: { id: true },
  });
  if (duplicado) {
    return rechazar(
      "Ese producto ya está en la publicación",
      tombstoneDe<ProductoSemanalPullDoc>(operacion),
    );
  }
  try {
    await tx.productoSemanal.create({
      data: {
        id: operacion.docId,
        fkPublicacion: nuevo.fkPublicacion,
        fkProducto: nuevo.fkProducto,
        fkUnidad,
        precio: nuevo.precio,
        stock: nuevo.stock,
        estado: nuevo.estado,
        version: 1,
      },
    });
  } catch (error) {
    // Concurrent same-offer create raced past the pre-check → partial unique.
    if ((error as { code?: string }).code === "P2002") {
      return rechazar(
        "Ese producto ya está en la publicación",
        tombstoneDe<ProductoSemanalPullDoc>(operacion),
      );
    }
    throw error;
  }
  await tx.syncCambio.create({
    data: {
      tablaOrigen: "producto_semanal",
      idFila: operacion.docId,
      operacion: "insert",
      actor: idUsuario,
    },
  });
  await registrarOperacion(
    tx,
    "productosSemanales",
    operacion,
    idUsuario,
    VEREDICTO.APLICADA,
    null,
  );
  return { ...base, veredicto: VEREDICTO.APLICADA };
}

async function aplicarUpdateItemSemanal(
  tx: Prisma.TransactionClient,
  operacion: OperacionItemSemanalPush,
  idUsuario: string,
  base: { operationId: string; docId: string },
  rechazar: (motivo: string, estadoServidor: unknown) => Promise<ResultadoPush>,
  conflicto: (estadoServidor: unknown) => Promise<ResultadoPush>,
): Promise<ResultadoPush> {
  const nuevo = operacion.nuevoEstado;
  // update — CAS on the item's server version.
  const actual = await tx.productoSemanal.findUnique({ where: { id: operacion.docId } });
  if (!actual) {
    return rechazar(
      "El artículo no existe en el servidor",
      tombstoneDe<ProductoSemanalPullDoc>(operacion),
    );
  }
  if (actual.fkPublicacion !== nuevo.fkPublicacion) {
    return rechazar("El artículo no puede moverse de publicación", aDocProductoSemanal(actual));
  }
  if (operacion.versionAsumida === null) {
    return conflicto(aDocProductoSemanal(actual));
  }
  const aplicadas = await tx.productoSemanal.updateMany({
    where: { id: operacion.docId, version: operacion.versionAsumida },
    data: {
      precio: nuevo.precio,
      stock: nuevo.stock,
      estado: nuevo.estado,
      version: { increment: 1 },
    },
  });
  if (aplicadas.count === 0) {
    const servidor = await tx.productoSemanal.findUnique({ where: { id: operacion.docId } });
    return conflicto(
      servidor ? aDocProductoSemanal(servidor) : { id: operacion.docId, _deleted: true },
    );
  }
  await tx.syncCambio.create({
    data: {
      tablaOrigen: "producto_semanal",
      idFila: operacion.docId,
      operacion: "update",
      actor: idUsuario,
    },
  });
  await registrarOperacion(
    tx,
    "productosSemanales",
    operacion,
    idUsuario,
    VEREDICTO.APLICADA,
    null,
  );
  return { ...base, veredicto: VEREDICTO.APLICADA };
}

async function aplicarOperacionItemSemanal(
  db: Database,
  idUsuario: string,
  operacion: OperacionItemSemanalPush,
): Promise<ResultadoPush> {
  const base = { operationId: operacion.operationId, docId: operacion.docId };
  try {
    return await db.$transaction(async (tx) => {
      // §5.2 step 2 — idempotency: a replay returns the stored verdict.
      const previa = await tx.syncOperacion.findUnique({ where: { id: operacion.operationId } });
      if (previa) return veredictoAlmacenado(previa);

      // Every verdict (aplicada/conflicto/rechazada) persists in the SAME tx (§7).
      const rechazar = async (motivo: string, estadoServidor: unknown): Promise<ResultadoPush> => {
        await registrarOperacion(
          tx,
          "productosSemanales",
          operacion,
          idUsuario,
          VEREDICTO.RECHAZADA,
          {
            motivo,
            estadoServidor,
          },
        );
        return { ...base, veredicto: VEREDICTO.RECHAZADA, motivo, estadoServidor };
      };
      const conflicto = async (estadoServidor: unknown): Promise<ResultadoPush> => {
        await registrarOperacion(
          tx,
          "productosSemanales",
          operacion,
          idUsuario,
          VEREDICTO.CONFLICTO,
          {
            estadoServidor,
          },
        );
        return { ...base, veredicto: VEREDICTO.CONFLICTO, estadoServidor };
      };

      const nuevo = operacion.nuevoEstado;
      if (operacion.op === "delete") {
        const actualDel = await tx.productoSemanal.findUnique({ where: { id: operacion.docId } });
        if (!actualDel) {
          // Delete of a never-pushed row: end state already achieved → no-op aplicada
          // (converges orphan cleanups without rejection loops).
          const motivo = "delete de fila inexistente; no-op";
          await registrarOperacion(
            tx,
            "productosSemanales",
            operacion,
            idUsuario,
            VEREDICTO.APLICADA,
            { motivo },
          );
          return { ...base, veredicto: VEREDICTO.APLICADA, motivo };
        }
        return rechazar(
          "Los artículos se retiran cambiando su estado a inactivo; no se eliminan físicamente",
          aDocProductoSemanal(actualDel),
        );
      }

      // Parent publication: must exist, be the farmer's OWN, and still be a draft
      // (items are only editable pre-publication — legacy Pu-rule parity).
      const pub = await tx.publicacionSemanal.findUnique({ where: { id: nuevo.fkPublicacion } });
      if (!pub) {
        // TRANSIENT: pub and item push over independent replication lanes; a missing
        // parent is a push-order race, not a domain violation. Throwing (5xx-class)
        // makes the replication RETRY — once the parent's push lands, the item applies.
        // shortcut: if the parent pub was REJECTED (tombstoned locally) its orphan items
        // retry indefinitely (visible in error$, invisible in PG); upgrade to a
        // client-side cascade removal when a draft-discard flow exists.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "La publicación del artículo aún no está sincronizada (reintento)",
        });
      }
      if (pub.fkAgricultor !== idUsuario) {
        return rechazar(
          "La publicación no es tuya",
          tombstoneDe<ProductoSemanalPullDoc>(operacion),
        );
      }
      if (pub.estado !== ESTADO_PUBLICACION.BORRADOR) {
        return rechazar(
          "Solo los borradores aceptan cambios de artículos; la confirmación es en línea",
          tombstoneDe<ProductoSemanalPullDoc>(operacion),
        );
      }

      if (operacion.op === "create") {
        return aplicarCreateItemSemanal(tx, operacion, idUsuario, base, rechazar);
      }

      return aplicarUpdateItemSemanal(tx, operacion, idUsuario, base, rechazar, conflicto);
    });
  } catch (error) {
    // §5.2 step 2 — idempotency race: a concurrent push committed this operationId.
    const previa = await db.syncOperacion.findUnique({ where: { id: operacion.operationId } });
    if (previa) return veredictoAlmacenado(previa);
    throw error;
  }
}

function makePushProcedure() {
  return protectedProcedure
    .input(
      z.object({
        coleccion: z.literal("localidades"),
        operaciones: z.array(operacionPushSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Legacy IsAdminOrReadOnly semantics: catalog writes are Admin-only; the role comes
      // from the verified access JWT (data-driven, backend-audit §2.5).
      if (ctx.user.rol !== ROLE.ADMIN) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Solo el rol Admin puede modificar localidades",
        });
      }
      const resultados: ResultadoPush[] = await Promise.all(
        input.operaciones.map((operacion) =>
          aplicarOperacionLocalidad(ctx.db, ctx.user.id, operacion),
        ),
      );
      return { resultados };
    });
}

function makePushProcedurePublicaciones() {
  return protectedProcedure
    .input(
      z.object({
        coleccion: z.literal("publicaciones"),
        operaciones: z.array(operacionPublicacionPushSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Drafts are farmer-owned (Q-19): Admin/Vendedor/Cliente manage online instead.
      if (ctx.user.rol !== ROLE.AGRICULTOR) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Solo el rol Agricultor puede enviar borradores de publicaciones",
        });
      }
      const resultados: ResultadoPush[] = await Promise.all(
        input.operaciones.map((operacion) =>
          aplicarOperacionPublicacion(ctx.db, ctx.user.id, operacion),
        ),
      );
      return { resultados };
    });
}

function makePushProcedureProductosSemanales() {
  return protectedProcedure
    .input(
      z.object({
        coleccion: z.literal("productosSemanales"),
        operaciones: z.array(operacionItemSemanalPushSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.rol !== ROLE.AGRICULTOR) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Solo el rol Agricultor puede enviar artículos de borradores",
        });
      }
      const resultados: ResultadoPush[] = await Promise.all(
        input.operaciones.map((operacion) =>
          aplicarOperacionItemSemanal(ctx.db, ctx.user.id, operacion),
        ),
      );
      return { resultados };
    });
}

// ---- PUSH (§5) — P0 Pedidos: S2 creation-in-queue (database.md §6.2 `pedidos` row) ----
//
// Lane rules (docs/synchronization.md §9): ONLY order creation travels as a push doc —
// the client sends items + notas; the server IGNORES the client's estado/totals and
// adjudicates through THE single adjudication entry point (stock + credit + items, Q-06/
// Q-10/Q-14). Push is allowed ONLY for the authenticated client's own orders (fk_cliente
// is bound to ctx.user.id). Transitions (cancelar/claimar/reasignar) are ONLINE-CONFIRM
// tRPC mutations — a pushed update/delete is rechazada. Verdicts: aplicada (adjudicated),
// rechazada (motivo stock/crédito/item inválido), conflicto (doc-id already server-side).
// Idempotency via sync_operacion: a replay returns the stored verdict with NO new effects.

const operacionPedidoPushSchema = z.object({
  operationId: z.uuid(),
  docId: z.uuid(),
  op: z.enum(["create", "update", "delete"]),
  // Server-owned fields stripped: fkCliente binds to the authenticated identity; the
  // estado/subtotal/iva/total are the SERVER's adjudication output — never the client's.
  nuevoEstado: z.object({
    items: z
      .array(
        z.object({
          fkProductoSemanal: z.uuid(),
          cantidad: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(50),
    notas: z.string().max(500).nullish(),
    _deleted: z.boolean().optional(),
  }),
  versionAsumida: z.number().int().positive().nullable(),
});
type OperacionPedidoPush = z.infer<typeof operacionPedidoPushSchema>;

async function aplicarOperacionPedido(
  db: Database,
  idUsuario: string,
  operacion: OperacionPedidoPush,
): Promise<ResultadoPush> {
  const base = { operationId: operacion.operationId, docId: operacion.docId };
  const tombstone: PedidoPullDoc = { id: operacion.docId, _deleted: true };
  try {
    return await db.$transaction(async (tx) => {
      // §5.2 step 2 — idempotency: a replay returns the stored verdict.
      const previa = await tx.syncOperacion.findUnique({ where: { id: operacion.operationId } });
      if (previa) return veredictoAlmacenado(previa);

      const rechazar = async (motivo: string, estadoServidor: unknown): Promise<ResultadoPush> => {
        await registrarOperacion(tx, "pedidos", operacion, idUsuario, VEREDICTO.RECHAZADA, {
          motivo,
          estadoServidor,
        });
        return { ...base, veredicto: VEREDICTO.RECHAZADA, motivo, estadoServidor };
      };
      const conflicto = async (estadoServidor: unknown): Promise<ResultadoPush> => {
        await registrarOperacion(tx, "pedidos", operacion, idUsuario, VEREDICTO.CONFLICTO, {
          estadoServidor,
        });
        return { ...base, veredicto: VEREDICTO.CONFLICTO, estadoServidor };
      };

      // Transitions never travel as raw push documents (§9: confirmación online).
      if (operacion.op === "delete") {
        return rechazar("La cancelación de pedidos se confirma en línea", tombstone);
      }
      if (operacion.op === "update") {
        return rechazar("Un pedido en cola no se edita; cancela y vuelve a crearlo", tombstone);
      }

      // create with a doc-id the server already has: not a replay (different
      // operationId) → conflicto with the real server state (§5.2 step 4).
      const actual = await tx.pedidoCabecera.findUnique({
        where: { id: operacion.docId },
        include: { estadoPedido: { select: { nombre: true } }, detalles: true },
      });
      if (actual) return conflicto(aDocPedido(actual));

      // THE single adjudication entry point — throws Rechazo on stock/credit/item
      // failure (the tx aborts, rolling back any partial stock decrement).
      await adjudicarPedido(tx, {
        fkCliente: idUsuario,
        fkVendedor: null,
        origen: ORIGEN_PEDIDO.DIGITAL,
        clienteNombre: null,
        clienteTelefono: null,
        notas: operacion.nuevoEstado.notas ?? null,
        items: operacion.nuevoEstado.items.map((i) => ({
          fkProductoSemanal: i.fkProductoSemanal,
          cantidad: i.cantidad,
        })),
        actor: idUsuario,
        docId: operacion.docId,
      });
      await registrarOperacion(tx, "pedidos", operacion, idUsuario, VEREDICTO.APLICADA, null);
      return { ...base, veredicto: VEREDICTO.APLICADA };
    });
  } catch (error) {
    if (error instanceof Rechazo) {
      // The tx rolled back (no effects); the rejection verdict persists OUTSIDE the tx.
      const respuesta = { motivo: error.message, estadoServidor: tombstone };
      try {
        await db.syncOperacion.create({
          data: {
            id: operacion.operationId,
            fkUsuario: idUsuario,
            coleccion: "pedidos",
            docId: operacion.docId,
            op: operacion.op,
            veredicto: VEREDICTO.RECHAZADA,
            respuesta: respuesta as unknown as Prisma.InputJsonValue,
          },
        });
      } catch {
        // A concurrent replay stored its verdict first — it is authoritative.
        const previa = await db.syncOperacion.findUnique({ where: { id: operacion.operationId } });
        if (previa) return veredictoAlmacenado(previa);
      }
      return {
        ...base,
        veredicto: VEREDICTO.RECHAZADA,
        motivo: error.message,
        estadoServidor: tombstone,
      };
    }
    // §5.2 step 2 — idempotency race: a concurrent push committed this operationId.
    const previa = await db.syncOperacion.findUnique({ where: { id: operacion.operationId } });
    if (previa) return veredictoAlmacenado(previa);
    throw error;
  }
}

function makePushProcedurePedidos() {
  return protectedProcedure
    .input(
      z.object({
        coleccion: z.literal("pedidos"),
        operaciones: z.array(operacionPedidoPushSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Order creation is the CLIENT lane (legacy HasRole(CLIENTE) parity): the pushed
      // order binds fk_cliente to the authenticated identity.
      if (ctx.user.rol !== ROLE.CLIENTE) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Solo el rol Cliente puede enviar pedidos en cola",
        });
      }
      const resultados: ResultadoPush[] = await Promise.all(
        input.operaciones.map((operacion) =>
          aplicarOperacionPedido(ctx.db, ctx.user.id, operacion),
        ),
      );
      return { resultados };
    });
}

// §3.1/§4.1 — one procedure per collection via a common factory; PUSH only registers collections
// with offline write (slice: localidades, §14). Familias collections are PULL-only (admin
// mutations are online tRPC procedures).
export const syncRouter = router({
  municipios: router({ pull: makePullProcedure("municipios") }),
  localidades: router({
    pull: makePullProcedure("localidades"),
    push: makePushProcedure(),
  }),
  categorias: router({ pull: makePullProcedure("categorias") }),
  unidades: router({ pull: makePullProcedure("unidades") }),
  productos: router({ pull: makePullProcedure("productos") }),
  imagenes: router({ pull: makePullProcedure("imagenes") }),
  familias: router({ pull: makeScopedPullProcedure("familias") }),
  membresias: router({ pull: makeScopedPullProcedure("membresias") }),
  limites_credito: router({ pull: makeScopedPullProcedure("limites_credito") }),
  usuarios: router({ pull: makeScopedPullProcedure("usuarios") }),
  // P0 Publicaciones (Q-25): scoped PULL + the first real S2 draft PUSH.
  publicaciones: router({
    pull: makeScopedPullProcedure("publicaciones"),
    push: makePushProcedurePublicaciones(),
  }),
  productosSemanales: router({
    pull: makeScopedPullProcedure("productosSemanales"),
    push: makePushProcedureProductosSemanales(),
  }),
  // P0 Pedidos (M-12): scoped PULL (client own / seller assigned / admin all) + the S2
  // creation PUSH (server adjudication); `detallesPedido` rides the parent's visibility;
  // `estadosPedido` is a global S1 lookup.
  estadosPedido: router({ pull: makePullProcedure("estadosPedido") }),
  pedidos: router({
    pull: makeScopedPullProcedure("pedidos"),
    push: makePushProcedurePedidos(),
  }),
  detallesPedido: router({ pull: makeScopedPullProcedure("detallesPedido") }),
});
