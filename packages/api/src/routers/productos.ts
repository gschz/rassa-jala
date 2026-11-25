import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Database, Prisma } from "@rassa-jala/db";

import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";
import { ACCION_LOG, registrarLog } from "../lib/registrar-log";

// P0 Productos — online admin CRUD for the master catalog (docs/scope.md §3.1
// "Productos — COMPLETAR", Q-19 RESUELTA: producto maestro = CRUD exclusivo Admin;
// Agricultor manages weekly offers in the LATER publicaciones feature, Vendedor neither).
// Normative sources: docs/database.md §3.2 (producto/producto_imagen rows), §6.2 (S1
// collections; the M-1a outbox), §6.3.6 (soft-delete). Patterns mirror catalogos.ts:
// - every mutation writes the row + one sync_cambio row in a SINGLE Prisma transaction
//   (M-1a), actor = authenticated user id;
// - updates compare-and-set `version` via updateMany (SP-2): 0 rows → CONFLICT;
// - mutations are Admin-only; `list` is any authenticated user (S1 global read).
//
// Deliberate scope decisions:
// - NO permanent-delete for producto (FK children + catalog semantics): soft-delete only,
//   estado=false reaches clients as _deleted=true via PULL.
// - producto_imagen.delete IS a physical delete (documented deviation from the catalog
//   soft-delete convention): the row is a reference to a stored object, not business
//   history — the binary is the source of truth and nothing references the row. The
//   outbox 'delete' operacion delivers the tombstone to clients.
// - Images: first image of a product becomes principal automatically; orden = max+1.
//   Deleting the principal image auto-promotes the next one by orden (same tx, its
//   own sync_cambio update — M-1a); no images left → the product keeps no principal
//   (valid state; the admin can still promote explicitly).
// - producto_imagen.estado exists per the §3.2 row conventions but no procedure produces
//   estado=false (physical delete is THE removal path for images).

const ID = z.uuid();
const VERSION = z.number().int().positive();
const NOMBRE = z.string().min(1).max(150);
const DESCRIPCION = z.string().max(500).nullish();

// ---- DTO shapes returned to clients (dates ISO 8601, database.md §6.3) ----

interface ImagenDto {
  id: string;
  // M-11 XOR: maestro images always carry it; semanal images have it null.
  fkProducto: string | null;
  fkProductoSemanal: string | null;
  storageKey: string;
  url: string;
  orden: number;
  principal: boolean;
  estado: boolean;
  version: number;
  actualizadoEn: string;
}

interface ProductoDto {
  id: string;
  nombre: string;
  descripcion: string | null;
  fkCategoria: string;
  fkUnidad: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  imagenes: ImagenDto[];
}

type FilaProducto = ElementoDe<Awaited<ReturnType<Database["producto"]["findMany"]>>>;
type FilaImagen = ElementoDe<Awaited<ReturnType<Database["productoImagen"]["findMany"]>>>;
type ElementoDe<A> = A extends readonly (infer T)[] ? T : never;

function aDtoImagen(fila: FilaImagen): ImagenDto {
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
  };
}

function aDtoProducto(fila: FilaProducto & { imagenes: FilaImagen[] }): ProductoDto {
  return {
    id: fila.id,
    nombre: fila.nombre,
    descripcion: fila.descripcion,
    fkCategoria: fila.fkCategoria,
    fkUnidad: fila.fkUnidad,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    imagenes: fila.imagenes.map(aDtoImagen),
  };
}

// ---- shared helpers (same contracts as catalogos.ts) ----

type OperacionOutbox = "insert" | "update" | "delete";

// M-1a: the outbox row rides in the SAME transaction as the row write.
async function enTransaccionConCambio<Valor>(
  db: Database,
  args: { tablaOrigen: string; operacion: OperacionOutbox; actor: string },
  mutar: (tx: Prisma.TransactionClient) => Promise<{ idFila: string; valor: Valor }>,
): Promise<Valor> {
  return db.$transaction(async (tx) => {
    const { idFila, valor } = await mutar(tx);
    await tx.syncCambio.create({
      data: {
        tablaOrigen: args.tablaOrigen,
        idFila,
        operacion: args.operacion,
        actor: args.actor,
      },
    });
    return valor;
  });
}

function asegurarAdmin(rol: Role): void {
  if (rol !== ROLE.ADMIN) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Solo el rol Admin puede modificar los productos",
    });
  }
}

function nombreNormalizado(bruto: string): string {
  const nombre = bruto.trim();
  if (!nombre) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "El nombre es obligatorio" });
  }
  return nombre;
}

function textoOpcional(bruto: string | null | undefined): string | null {
  const texto = bruto?.trim();
  return texto || null;
}

async function asegurarNombreUnico(
  nombre: string,
  contexto: string,
  buscarDuplicado: () => Promise<{ id: string } | null>,
): Promise<void> {
  const duplicado = await buscarDuplicado();
  if (duplicado) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Ya existe ${contexto} con el nombre "${nombre}"`,
    });
  }
}

async function asegurarCategoriaActiva(
  tx: Prisma.TransactionClient,
  fkCategoria: string,
): Promise<void> {
  const categoria = await tx.categoriaProducto.findUnique({
    where: { id: fkCategoria },
    select: { estado: true },
  });
  if (!categoria?.estado) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "La categoría indicada no existe o está inactiva",
    });
  }
}

async function asegurarUnidadActiva(tx: Prisma.TransactionClient, fkUnidad: string): Promise<void> {
  const unidad = await tx.unidad.findUnique({
    where: { id: fkUnidad },
    select: { estado: true },
  });
  if (!unidad?.estado) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "La unidad indicada no existe o está inactiva",
    });
  }
}

// SP-2 — 0 updated rows means the version moved (or the row vanished); the message
// carries the server's current version so the admin can retry with fresh state.
function errorConflictoVersion(versionEnviada: number, versionActual: number | null): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message:
      versionActual === null
        ? `Conflicto de versión: el registro no existe en el servidor (versión enviada: ${versionEnviada})`
        : `Conflicto de versión: el registro cambió en el servidor (versión actual: ${versionActual}, enviada: ${versionEnviada})`,
  });
}

// ---- image upload validation (trust boundary) — shared with publicaciones.ts ----

export const MIME_PERMITIDOS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;
export type MimePermitido = keyof typeof MIME_PERMITIDOS;

export const MAX_BYTES = 5 * 1024 * 1024; // ~5 MiB (MVP; no image pipeline)
const BASE64_VALIDO = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodificarBase64(bruto: string): Uint8Array {
  // Accept (and strip) a data-URL prefix defensively; the web client sends raw base64.
  const limpio = bruto.replace(/^data:[^,]+;base64,/, "").replace(/\s+/g, "");
  if (!limpio || !BASE64_VALIDO.test(limpio)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "El archivo no es base64 válido" });
  }
  const bytes = Buffer.from(limpio, "base64");
  if (bytes.byteLength === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "El archivo está vacío" });
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "La imagen supera el tamaño máximo de 5 MiB",
    });
  }
  return bytes;
}

export function extensionCoincide(fileName: string, mime: MimePermitido): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const esperadas = mime === "image/jpeg" ? ["jpg", "jpeg"] : [MIME_PERMITIDOS[mime]];
  return (esperadas as readonly string[]).includes(extension);
}

// Content is the source of truth: the client-declared MIME is untrusted, so the
// decoded bytes must carry the real PNG/JPEG/WebP signature matching the declared
// type; unknown signatures are rejected too.
export function asegurarFirmaImagen(bytes: Uint8Array, mimeDeclarado: MimePermitido): void {
  // 12 bytes cover every signature: PNG (8), JPEG (3), WebP ("RIFF" 0-3 + "WEBP" 8-11).
  const hex = Buffer.from(bytes.subarray(0, 12)).toString("hex");
  const detectado: MimePermitido | null = hex.startsWith("89504e470d0a1a0a")
    ? "image/png"
    : hex.startsWith("ffd8ff")
      ? "image/jpeg"
      : hex.startsWith("52494646") && hex.slice(16) === "57454250"
        ? "image/webp"
        : null;
  if (detectado !== mimeDeclarado) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "El contenido del archivo no coincide con el tipo de imagen declarado",
    });
  }
}

const IMAGEN_ENTRADA = z.object({
  fkProducto: ID,
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  // gap 3 transport resolved: the web client uploads multipart (POST /upload/imagenes,
  // Bun-native formData) and the server bridges the bytes into THIS procedure — base64
  // remains only as the old-client tRPC contract and the in-process bridge input.
  dataBase64: z.string().min(1),
});

// ---- procedures ----

export const productosRouter = router({
  // Any authenticated user (S1 global read, database.md §6.2 — as amended by Q-19 the
  // master catalog is Admin-owned for WRITES; read scope is global).
  list: protectedProcedure
    .input(z.object({ incluirInactivos: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const filas = await ctx.db.producto.findMany({
        where: input.incluirInactivos ? undefined : { estado: true },
        orderBy: { nombre: "asc" },
        include: { imagenes: { orderBy: { orden: "asc" } } },
      });
      return filas.map(aDtoProducto);
    }),

  create: protectedProcedure
    .input(
      z.object({
        nombre: NOMBRE,
        descripcion: DESCRIPCION,
        fkCategoria: ID,
        fkUnidad: ID.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const descripcion = textoOpcional(input.descripcion);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "producto", operacion: "insert", actor: ctx.user.id },
        async (tx) => {
          await asegurarCategoriaActiva(tx, input.fkCategoria);
          if (input.fkUnidad) await asegurarUnidadActiva(tx, input.fkUnidad);
          await asegurarNombreUnico(nombre, "un producto", () =>
            tx.producto.findFirst({ where: { nombre }, select: { id: true } }),
          );
          const fila = await tx.producto.create({
            data: {
              nombre,
              descripcion,
              fkCategoria: input.fkCategoria,
              ...(input.fkUnidad ? { fkUnidad: input.fkUnidad } : {}),
            },
            include: { imagenes: true },
          });
          await registrarLog(tx, {
            ip: ctx.ip,
            dispositivo: ctx.dispositivo,
            usuarioId: ctx.user.id,
            accion: ACCION_LOG.PRODUCTO_CREAR,
            entidad: "producto",
            entidadId: fila.id,
            detalle: { nombre },
          });
          return { idFila: fila.id, valor: aDtoProducto(fila) };
        },
      );
      return valor;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: ID,
        version: VERSION,
        nombre: NOMBRE,
        descripcion: DESCRIPCION,
        fkCategoria: ID.optional(),
        // null = clear the unidad; undefined = keep current (not sent).
        fkUnidad: ID.nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const descripcion = textoOpcional(input.descripcion);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "producto", operacion: "update", actor: ctx.user.id },
        async (tx) => {
          // FKs validated only when sent (an unchanged parent must not block edits of
          // products whose categoria/unidad was deactivated in the meantime).
          if (input.fkCategoria) await asegurarCategoriaActiva(tx, input.fkCategoria);
          if (input.fkUnidad) await asegurarUnidadActiva(tx, input.fkUnidad);
          await asegurarNombreUnico(nombre, "un producto", () =>
            tx.producto.findFirst({
              where: { nombre, id: { not: input.id } },
              select: { id: true },
            }),
          );
          const aplicadas = await tx.producto.updateMany({
            where: { id: input.id, version: input.version },
            data: {
              nombre,
              descripcion,
              ...(input.fkCategoria ? { fkCategoria: input.fkCategoria } : {}),
              ...(input.fkUnidad !== undefined ? { fkUnidad: input.fkUnidad } : {}),
              version: { increment: 1 },
            },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.producto.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          const fila = await tx.producto.findUniqueOrThrow({
            where: { id: input.id },
            include: { imagenes: true },
          });
          await registrarLog(tx, {
            ip: ctx.ip,
            dispositivo: ctx.dispositivo,
            usuarioId: ctx.user.id,
            accion: ACCION_LOG.PRODUCTO_ACTUALIZAR,
            entidad: "producto",
            entidadId: fila.id,
            detalle: { nombre },
          });
          return { idFila: fila.id, valor: aDtoProducto(fila) };
        },
      );
      return valor;
    }),

  setEstado: protectedProcedure
    .input(z.object({ id: ID, version: VERSION, estado: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      // Deactivating a producto does NOT touch its images: rows are managed
      // independently and clients receive per-row states via PULL (catalogos parity).
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "producto", operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const aplicadas = await tx.producto.updateMany({
            where: { id: input.id, version: input.version },
            data: { estado: input.estado, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.producto.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          await registrarLog(tx, {
            ip: ctx.ip,
            dispositivo: ctx.dispositivo,
            usuarioId: ctx.user.id,
            accion: ACCION_LOG.PRODUCTO_CAMBIAR_ESTADO,
            entidad: "producto",
            entidadId: input.id,
            detalle: { estado: input.estado },
          });
          return { idFila: input.id, valor: { ok: true } };
        },
      );
      return valor;
    }),

  imagenes: router({
    upload: protectedProcedure.input(IMAGEN_ENTRADA).mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const bytes = decodificarBase64(input.dataBase64);
      asegurarFirmaImagen(bytes, input.mimeType);
      if (!extensionCoincide(input.fileName, input.mimeType)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "La extensión del archivo no coincide con su tipo de contenido",
        });
      }
      const producto = await ctx.db.producto.findUnique({
        where: { id: input.fkProducto },
        select: { estado: true },
      });
      if (!producto?.estado) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "El producto indicado no existe o está inactivo",
        });
      }

      // Adapter write OUTSIDE the DB tx: the file is stored first, then the row + outbox
      // commit atomically; on tx failure the saved file is removed (best-effort) so no
      // orphan appears for a failed upload.
      const guardado = await ctx.storage.save(bytes, MIME_PERMITIDOS[input.mimeType]);
      try {
        return await enTransaccionConCambio(
          ctx.db,
          { tablaOrigen: "producto_imagen", operacion: "insert", actor: ctx.user.id },
          async (tx) => {
            const [ultima, total] = await Promise.all([
              tx.productoImagen.findFirst({
                where: { fkProducto: input.fkProducto },
                orderBy: { orden: "desc" },
                select: { orden: true },
              }),
              tx.productoImagen.count({ where: { fkProducto: input.fkProducto } }),
            ]);
            const fila = await tx.productoImagen.create({
              data: {
                fkProducto: input.fkProducto,
                storageKey: guardado.storageKey,
                url: guardado.url,
                orden: (ultima?.orden ?? -1) + 1,
                // First image of the product becomes principal automatically (docs
                // partial unique guards the concurrent-first-upload race as CONFLICT).
                principal: total === 0,
              },
            });
            await registrarLog(tx, {
              ip: ctx.ip,
              dispositivo: ctx.dispositivo,
              usuarioId: ctx.user.id,
              accion: ACCION_LOG.PRODUCTO_IMAGEN_SUBIR,
              entidad: "producto_imagen",
              entidadId: fila.id,
              detalle: { fkProducto: input.fkProducto, fileName: input.fileName },
            });
            return { idFila: fila.id, valor: aDtoImagen(fila) };
          },
        );
      } catch (error) {
        await ctx.storage.remove(guardado.storageKey);
        // Concurrent first-upload: the DB partial unique rejects the second
        // principal=true row — surface it as one clear 409.
        if ((error as { code?: string }).code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Otra imagen fue registrada como principal al mismo tiempo",
          });
        }
        throw error;
      }
    }),

    setPrincipal: protectedProcedure
      .input(z.object({ id: ID, version: VERSION }))
      .mutation(async ({ input, ctx }) => {
        asegurarAdmin(ctx.user.rol);
        const valor = await enTransaccionConCambio(
          ctx.db,
          { tablaOrigen: "producto_imagen", operacion: "update", actor: ctx.user.id },
          async (tx) => {
            const fila = await tx.productoImagen.findUnique({
              where: { id: input.id },
              select: { fkProducto: true },
            });
            if (!fila) throw errorConflictoVersion(input.version, null);
            // Unset the siblings FIRST (the partial unique demands it) and outbox each
            // affected row — the outbox is the only change-delivery channel.
            const otras = await tx.productoImagen.findMany({
              where: { fkProducto: fila.fkProducto, principal: true, id: { not: input.id } },
              select: { id: true },
            });
            if (otras.length > 0) {
              await tx.productoImagen.updateMany({
                where: { id: { in: otras.map((o) => o.id) } },
                data: { principal: false, version: { increment: 1 } },
              });
              await tx.syncCambio.createMany({
                data: otras.map((o) => ({
                  tablaOrigen: "producto_imagen",
                  idFila: o.id,
                  operacion: "update",
                  actor: ctx.user.id,
                })),
              });
            }
            const aplicadas = await tx.productoImagen.updateMany({
              where: { id: input.id, version: input.version },
              data: { principal: true, version: { increment: 1 } },
            });
            if (aplicadas.count === 0) {
              const actual = await tx.productoImagen.findUnique({
                where: { id: input.id },
                select: { version: true },
              });
              throw errorConflictoVersion(input.version, actual?.version ?? null);
            }
            const actualizada = await tx.productoImagen.findUniqueOrThrow({
              where: { id: input.id },
            });
            await registrarLog(tx, {
              ip: ctx.ip,
              dispositivo: ctx.dispositivo,
              usuarioId: ctx.user.id,
              accion: ACCION_LOG.PRODUCTO_IMAGEN_PRINCIPAL,
              entidad: "producto_imagen",
              entidadId: input.id,
              detalle: { fkProducto: actualizada.fkProducto },
            });
            return { idFila: input.id, valor: aDtoImagen(actualizada) };
          },
        );
        return valor;
      }),

    delete: protectedProcedure
      .input(z.object({ id: ID, version: VERSION }))
      .mutation(async ({ input, ctx }) => {
        asegurarAdmin(ctx.user.rol);
        const { storageKey } = await enTransaccionConCambio(
          ctx.db,
          { tablaOrigen: "producto_imagen", operacion: "delete", actor: ctx.user.id },
          async (tx) => {
            const fila = await tx.productoImagen.findUnique({
              where: { id: input.id },
              select: { storageKey: true, fkProducto: true, principal: true },
            });
            if (!fila) throw errorConflictoVersion(input.version, null);
            const aplicadas = await tx.productoImagen.deleteMany({
              where: { id: input.id, version: input.version },
            });
            if (aplicadas.count === 0) {
              const actual = await tx.productoImagen.findUnique({
                where: { id: input.id },
                select: { version: true },
              });
              throw errorConflictoVersion(input.version, actual?.version ?? null);
            }
            // Auto-promotion (roadmap §7 gap 4): deleting the principal promotes the
            // next image by orden IN the same tx — the promotion is a plain update
            // with its own sync_cambio row, so PULL delivers it (M-1a). No remaining
            // image → the product keeps no principal (valid state). Safe against the
            // partial unique: the old principal row is already deleted above.
            if (fila.principal && fila.fkProducto) {
              const siguiente = await tx.productoImagen.findFirst({
                where: { fkProducto: fila.fkProducto },
                orderBy: { orden: "asc" },
                select: { id: true },
              });
              if (siguiente) {
                await tx.productoImagen.update({
                  where: { id: siguiente.id },
                  data: { principal: true, version: { increment: 1 } },
                });
                await tx.syncCambio.create({
                  data: {
                    tablaOrigen: "producto_imagen",
                    idFila: siguiente.id,
                    operacion: "update",
                    actor: ctx.user.id,
                  },
                });
              }
            }
            await registrarLog(tx, {
              ip: ctx.ip,
              dispositivo: ctx.dispositivo,
              usuarioId: ctx.user.id,
              accion: ACCION_LOG.PRODUCTO_IMAGEN_ELIMINAR,
              entidad: "producto_imagen",
              entidadId: input.id,
              detalle: { fkProducto: fila.fkProducto },
            });
            return { idFila: input.id, valor: { storageKey: fila.storageKey } };
          },
        );
        // After the tx commits: best-effort unlink of the stored object. An orphan file
        // is acceptable in dev (remove() warns); the row is already gone either way.
        await ctx.storage.remove(storageKey);
        return { ok: true };
      }),
  }),
});
