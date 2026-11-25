import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  ESTADO_ITEM_SEMANAL,
  ESTADO_PUBLICACION,
  aFechaCiclo,
  esLunesFecha,
  esLunesNegocio,
  isoWeekFromMonday,
  mondayOfBusinessWeek,
  parseFechaCiclo,
} from "@rassa-jala/db";
import type { Database, Prisma } from "@rassa-jala/db";

import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";
import { ACCION_LOG, registrarLog } from "../lib/registrar-log";
import {
  asegurarFirmaImagen,
  decodificarBase64,
  extensionCoincide,
  MIME_PERMITIDOS,
  type MimePermitido,
} from "./productos";

// P0 Publicaciones semanales — normative sources: docs/database.md §3.3 (rows),
// §6.2 (S2 `publicaciones`: farmer drafts offline-conditioned, buyers see published
// current-ciclo offers), Q-25 (scope.md §3.2: ISO calendar weeks 1–53, ciclo = its
// Monday date, uniqueness (agricultor, fecha_ciclo), publication ONLY on Mondays in
// America/Mazatlan) and the legacy lifecycle (blueprints/publicacion/views.py):
// borrador→publicado→cerrado (+cancelado), items only editable as borrador, quitar =
// estado 'inactivo' (soft), publish validates per item (Pu4).
//
// Lane split (docs/synchronization.md §9): draft create/edit is S2-replicable (push
// carries borrador docs only — sync.ts handlers); publish/cancelar/cerrar are
// ONLINE-CONFIRM mutations (never raw push documents). Every mutation writes the row
// + its sync_cambio outbox row in a single transaction (M-1a); updates compare-and-set
// `version` (SP-2). Money: zod validates the decimal STRING (never float, F-29/Q-14)
// and Prisma stores numeric(10,2).

const ID = z.uuid();
const VERSION = z.number().int().positive();
// Calendar date 'YYYY-MM-DD' (the ciclo's ISO Monday; D-6 day semantics).
const FECHA_CICLO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Money as string: digits, optional 1–2 decimals — parsed by Prisma Decimal (no float).
const PRECIO = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/);

// ---- DTO shapes (dates ISO 8601, money as string — database.md §6.3) ----

interface ImagenRefDto {
  url: string;
  principal: boolean;
}

interface ItemSemanalDto {
  id: string;
  fkPublicacion: string;
  fkProducto: string;
  fkUnidad: string;
  precio: string;
  stock: number;
  estado: string;
  version: number;
  actualizadoEn: string;
}

interface PublicacionDto {
  id: string;
  fkAgricultor: string | null;
  fechaCiclo: string;
  semanaIso: number;
  anioIso: number;
  estado: string;
  version: number;
  actualizadoEn: string;
  items: ItemSemanalDto[];
}

type FilaPublicacion = Awaited<ReturnType<Database["publicacionSemanal"]["findMany"]>>[number];
type FilaItem = Awaited<ReturnType<Database["productoSemanal"]["findMany"]>>[number];
type FilaImagen = Awaited<ReturnType<Database["productoImagen"]["findMany"]>>[number];

function aDtoItem(fila: FilaItem): ItemSemanalDto {
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
  };
}

function aDtoPublicacion(fila: FilaPublicacion & { items: FilaItem[] }): PublicacionDto {
  return {
    id: fila.id,
    fkAgricultor: fila.fkAgricultor,
    fechaCiclo: aFechaCiclo(fila.fechaCiclo),
    semanaIso: fila.semanaIso,
    anioIso: fila.anioIso,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    items: fila.items.map(aDtoItem),
  };
}

function aDtoImagenRef(fila: FilaImagen): ImagenRefDto {
  return { url: fila.url, principal: fila.principal };
}

// ---- shared helpers (same contracts as productos.ts) ----

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

// Q-19: the Agricultor manages its own weekly offers; Admin keeps management access
// (read + transitions on any farmer's publications). Vendedor/Cliente → 403.
function asegurarGestion(rol: Role): void {
  if (rol !== ROLE.AGRICULTOR && rol !== ROLE.ADMIN) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Solo los roles Agricultor o Admin pueden gestionar publicaciones",
    });
  }
}

// Ownership gate: a farmer may only touch its own publications (Admin: any).
async function cargarPublicacionGestionable(
  tx: Prisma.TransactionClient,
  id: string,
  usuarioId: string,
  rol: Role,
): Promise<FilaPublicacion> {
  const fila = await tx.publicacionSemanal.findUnique({ where: { id } });
  if (!fila) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Publicación no encontrada" });
  }
  if (rol !== ROLE.ADMIN && fila.fkAgricultor !== usuarioId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "La publicación no es tuya" });
  }
  return fila;
}

// SP-2 — 0 updated rows means the version moved (or the row vanished).
function errorConflictoVersion(versionEnviada: number, versionActual: number | null): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message:
      versionActual === null
        ? `Conflicto de versión: el registro no existe en el servidor (versión enviada: ${versionEnviada})`
        : `Conflicto de versión: el registro cambió en el servidor (versión actual: ${versionActual}, enviada: ${versionEnviada})`,
  });
}

async function asegurarUnidadActiva(tx: Prisma.TransactionClient, fkUnidad: string): Promise<void> {
  const unidad = await tx.unidad.findUnique({ where: { id: fkUnidad }, select: { estado: true } });
  if (!unidad?.estado) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "La unidad indicada no existe o está inactiva",
    });
  }
}

// ---- procedures ----

export const publicacionesRouter = router({
  // Farmer: own publications (all weeks); Admin: any farmer's via filter.
  misPublicaciones: protectedProcedure
    .input(z.object({ fkAgricultor: ID.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const esAdmin = ctx.user.rol === ROLE.ADMIN;
      if (!esAdmin && input?.fkAgricultor && input.fkAgricultor !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "La publicación no es tuya" });
      }
      const filas = await ctx.db.publicacionSemanal.findMany({
        where: esAdmin
          ? input?.fkAgricultor
            ? { fkAgricultor: input.fkAgricultor }
            : {}
          : { fkAgricultor: ctx.user.id },
        orderBy: [{ fechaCiclo: "desc" }, { creadoEn: "desc" }],
        include: { items: { orderBy: { creadoEn: "asc" } } },
      });
      return filas.map(aDtoPublicacion);
    }),

  detalle: protectedProcedure.input(z.object({ id: ID })).query(async ({ input, ctx }) => {
    const fila = await ctx.db.publicacionSemanal.findUnique({
      where: { id: input.id },
      include: {
        items: {
          orderBy: { creadoEn: "asc" },
          include: { imagenes: { orderBy: { orden: "asc" } } },
        },
      },
    });
    if (!fila) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Publicación no encontrada" });
    }
    if (ctx.user.rol !== ROLE.ADMIN && fila.fkAgricultor !== ctx.user.id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "La publicación no es tuya" });
    }
    return {
      ...aDtoPublicacion({ ...fila, items: fila.items }),
      items: fila.items.map((item) => ({
        ...aDtoItem(item),
        imagenes: item.imagenes.map(aDtoImagenRef),
      })),
    };
  }),

  crearBorrador: protectedProcedure
    .input(z.object({ fechaCiclo: FECHA_CICLO.optional() }))
    .mutation(async ({ input, ctx }) => {
      asegurarGestion(ctx.user.rol);
      // Default: the CURRENT ciclo's Monday (Q-25). Any explicit value must be a Monday.
      const fecha = input.fechaCiclo ?? aFechaCiclo(mondayOfBusinessWeek(new Date()));
      if (!esLunesFecha(fecha)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "La fecha de ciclo debe ser un lunes (ISO 8601)",
        });
      }
      const { semanaIso, anioIso } = isoWeekFromMonday(parseFechaCiclo(fecha));
      return enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "publicacion_semanal", operacion: "insert", actor: ctx.user.id },
        async (tx) => {
          // CANCELLED rows free the ciclo: legacy blocked re-creation forever after a
          // cancel (full UNIQUE (fk_agricultor, semana) over any state) — a defect we do
          // not inherit; the partial unique excludes 'cancelado' for the same reason.
          const duplicada = await tx.publicacionSemanal.findFirst({
            where: {
              fkAgricultor: ctx.user.id,
              fechaCiclo: parseFechaCiclo(fecha),
              estado: { not: ESTADO_PUBLICACION.CANCELADO },
            },
            select: { id: true },
          });
          if (duplicada) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `Ya existe una publicación para el ciclo del ${fecha}`,
            });
          }
          try {
            const fila = await tx.publicacionSemanal.create({
              data: {
                fkAgricultor: ctx.user.id,
                fechaCiclo: parseFechaCiclo(fecha),
                semanaIso,
                anioIso,
                estado: ESTADO_PUBLICACION.BORRADOR,
              },
              include: { items: true },
            });
            return { idFila: fila.id, valor: aDtoPublicacion(fila) };
          } catch (error) {
            // Concurrent same-ciclo create raced past the pre-check → partial unique.
            if ((error as { code?: string }).code === "P2002") {
              throw new TRPCError({
                code: "CONFLICT",
                message: `Ya existe una publicación para el ciclo del ${fecha}`,
              });
            }
            throw error;
          }
        },
      );
    }),

  agregarItem: protectedProcedure
    .input(
      z.object({
        publicacionId: ID,
        fkProducto: ID,
        precio: PRECIO,
        stock: z.number().int().min(0),
        fkUnidad: ID.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarGestion(ctx.user.rol);
      return enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "producto_semanal", operacion: "insert", actor: ctx.user.id },
        async (tx) => {
          const pub = await cargarPublicacionGestionable(
            tx,
            input.publicacionId,
            ctx.user.id,
            ctx.user.rol,
          );
          if (pub.estado !== ESTADO_PUBLICACION.BORRADOR) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Solo se pueden agregar productos a una publicación en estado borrador",
            });
          }
          const producto = await tx.producto.findUnique({ where: { id: input.fkProducto } });
          if (!producto?.estado) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "El producto indicado no existe o está inactivo",
            });
          }
          // Inherit the maestro's unidad when not sent (legacy serializer allowed null at
          // item level; the DB column is NOT NULL and publish required it — Pu4).
          const fkUnidad = input.fkUnidad ?? producto.fkUnidad;
          if (!fkUnidad) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "La unidad es requerida" });
          }
          await asegurarUnidadActiva(tx, fkUnidad);
          const duplicado = await tx.productoSemanal.findFirst({
            where: {
              fkPublicacion: input.publicacionId,
              fkProducto: input.fkProducto,
              estado: ESTADO_ITEM_SEMANAL.ACTIVO,
            },
            select: { id: true },
          });
          if (duplicado) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Ese producto ya está en la publicación",
            });
          }
          const fila = await tx.productoSemanal.create({
            data: {
              fkPublicacion: input.publicacionId,
              fkProducto: input.fkProducto,
              fkUnidad,
              precio: input.precio,
              stock: input.stock,
              estado: ESTADO_ITEM_SEMANAL.ACTIVO,
            },
          });
          return { idFila: fila.id, valor: aDtoItem(fila) };
        },
      );
    }),

  editarItem: protectedProcedure
    .input(
      z.object({
        id: ID,
        version: VERSION,
        precio: PRECIO.optional(),
        stock: z.number().int().min(0).optional(),
        fkUnidad: ID.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarGestion(ctx.user.rol);
      return enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "producto_semanal", operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const item = await tx.productoSemanal.findUnique({ where: { id: input.id } });
          if (!item) throw errorConflictoVersion(input.version, null);
          await cargarPublicacionGestionable(tx, item.fkPublicacion, ctx.user.id, ctx.user.rol);
          const pub = await tx.publicacionSemanal.findUniqueOrThrow({
            where: { id: item.fkPublicacion },
          });
          if (pub.estado !== ESTADO_PUBLICACION.BORRADOR) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Solo se pueden modificar productos en una publicación en estado borrador",
            });
          }
          if (input.fkUnidad) await asegurarUnidadActiva(tx, input.fkUnidad);
          const aplicadas = await tx.productoSemanal.updateMany({
            where: { id: input.id, version: input.version },
            data: {
              ...(input.precio !== undefined ? { precio: input.precio } : {}),
              ...(input.stock !== undefined ? { stock: input.stock } : {}),
              ...(input.fkUnidad !== undefined ? { fkUnidad: input.fkUnidad } : {}),
              version: { increment: 1 },
            },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.productoSemanal.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          const fila = await tx.productoSemanal.findUniqueOrThrow({ where: { id: input.id } });
          return { idFila: fila.id, valor: aDtoItem(fila) };
        },
      );
    }),

  // Legacy parity: quitar is a SOFT state change (estado='inactivo', restorable while
  // the publication is a draft) — items are never hard-deleted (database.md §6.3.5).
  quitarItem: protectedProcedure
    .input(z.object({ id: ID, version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      asegurarGestion(ctx.user.rol);
      return enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "producto_semanal", operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const item = await tx.productoSemanal.findUnique({ where: { id: input.id } });
          if (!item) throw errorConflictoVersion(input.version, null);
          await cargarPublicacionGestionable(tx, item.fkPublicacion, ctx.user.id, ctx.user.rol);
          const pub = await tx.publicacionSemanal.findUniqueOrThrow({
            where: { id: item.fkPublicacion },
          });
          if (pub.estado !== ESTADO_PUBLICACION.BORRADOR) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Solo se pueden modificar productos en una publicación en estado borrador",
            });
          }
          const aplicadas = await tx.productoSemanal.updateMany({
            where: { id: input.id, version: input.version },
            data: { estado: ESTADO_ITEM_SEMANAL.INACTIVO, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.productoSemanal.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          const fila = await tx.productoSemanal.findUniqueOrThrow({ where: { id: input.id } });
          return { idFila: fila.id, valor: aDtoItem(fila) };
        },
      );
    }),

  // Pu1 (Q-25): publication happens ONLY on the ciclo's Monday, business time in
  // America/Mazatlan. Pu4 (legacy parity): at least one active item, each with
  // precio > 0 and stock > 0 (drafts may carry 0 values; publish may not).
  publicar: protectedProcedure
    .input(z.object({ publicacionId: ID, version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      asegurarGestion(ctx.user.rol);
      return enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "publicacion_semanal", operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const pub = await cargarPublicacionGestionable(
            tx,
            input.publicacionId,
            ctx.user.id,
            ctx.user.rol,
          );
          if (pub.estado !== ESTADO_PUBLICACION.BORRADOR) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Solo se puede publicar una publicación en estado borrador",
            });
          }
          const ahora = new Date();
          if (
            !esLunesNegocio(ahora) ||
            aFechaCiclo(pub.fechaCiclo) !== aFechaCiclo(mondayOfBusinessWeek(ahora))
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "Las publicaciones solo pueden publicarse el lunes de su ciclo (America/Mazatlan)",
            });
          }
          const items = await tx.productoSemanal.findMany({
            where: { fkPublicacion: pub.id, estado: ESTADO_ITEM_SEMANAL.ACTIVO },
          });
          if (items.length === 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "No hay productos activos para publicar",
            });
          }
          const invalidos = items.filter((item) => item.precio.lte(0) || item.stock <= 0);
          if (invalidos.length > 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Hay productos con precio o stock inválidos para publicar (ids: ${invalidos.map((i) => i.id.slice(0, 8)).join(", ")})`,
            });
          }
          const aplicadas = await tx.publicacionSemanal.updateMany({
            where: { id: pub.id, version: input.version },
            data: { estado: ESTADO_PUBLICACION.PUBLICADO, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            throw errorConflictoVersion(input.version, pub.version);
          }
          await registrarLog(tx, {
            ip: ctx.ip,
            dispositivo: ctx.dispositivo,
            usuarioId: ctx.user.id,
            accion: ACCION_LOG.PUBLICACION_PUBLICAR,
            entidad: "publicacion_semanal",
            entidadId: pub.id,
            detalle: { fechaCiclo: aFechaCiclo(pub.fechaCiclo) },
          });
          const fila = await tx.publicacionSemanal.findUniqueOrThrow({
            where: { id: pub.id },
            include: { items: true },
          });
          return { idFila: fila.id, valor: aDtoPublicacion(fila) };
        },
      );
    }),

  cancelar: protectedProcedure
    .input(z.object({ publicacionId: ID, version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      asegurarGestion(ctx.user.rol);
      return enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "publicacion_semanal", operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const pub = await cargarPublicacionGestionable(
            tx,
            input.publicacionId,
            ctx.user.id,
            ctx.user.rol,
          );
          if (
            pub.estado !== ESTADO_PUBLICACION.BORRADOR &&
            pub.estado !== ESTADO_PUBLICACION.PUBLICADO
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Solo se pueden cancelar publicaciones en borrador o publicadas",
            });
          }
          const aplicadas = await tx.publicacionSemanal.updateMany({
            where: { id: pub.id, version: input.version },
            data: { estado: ESTADO_PUBLICACION.CANCELADO, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            throw errorConflictoVersion(input.version, pub.version);
          }
          await registrarLog(tx, {
            ip: ctx.ip,
            dispositivo: ctx.dispositivo,
            usuarioId: ctx.user.id,
            accion: ACCION_LOG.PUBLICACION_CANCELAR,
            entidad: "publicacion_semanal",
            entidadId: pub.id,
          });
          const fila = await tx.publicacionSemanal.findUniqueOrThrow({
            where: { id: pub.id },
            include: { items: true },
          });
          return { idFila: fila.id, valor: aDtoPublicacion(fila) };
        },
      );
    }),

  // End-of-cycle operation: allowed ANY day (legacy close; no Monday gate here).
  cerrar: protectedProcedure
    .input(z.object({ publicacionId: ID, version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      asegurarGestion(ctx.user.rol);
      return enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: "publicacion_semanal", operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const pub = await cargarPublicacionGestionable(
            tx,
            input.publicacionId,
            ctx.user.id,
            ctx.user.rol,
          );
          if (pub.estado !== ESTADO_PUBLICACION.PUBLICADO) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Solo se puede cerrar una publicación en estado publicado",
            });
          }
          const aplicadas = await tx.publicacionSemanal.updateMany({
            where: { id: pub.id, version: input.version },
            data: { estado: ESTADO_PUBLICACION.CERRADO, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            throw errorConflictoVersion(input.version, pub.version);
          }
          const fila = await tx.publicacionSemanal.findUniqueOrThrow({
            where: { id: pub.id },
            include: { items: true },
          });
          return { idFila: fila.id, valor: aDtoPublicacion(fila) };
        },
      );
    }),

  // Buyer view (any authenticated user): the CURRENT ciclo's published offers with
  // their active items (producto maestro info + price + stock + images). Scoping
  // parity with the `publicaciones` PULL for buyers (database.md §6.2).
  catalogoCliente: protectedProcedure.query(async ({ ctx }) => {
    const lunes = mondayOfBusinessWeek(new Date());
    const filas = await ctx.db.publicacionSemanal.findMany({
      where: { estado: ESTADO_PUBLICACION.PUBLICADO, fechaCiclo: lunes },
      include: {
        items: {
          where: { estado: ESTADO_ITEM_SEMANAL.ACTIVO },
          orderBy: { creadoEn: "asc" },
          include: {
            producto: { include: { categoria: true, imagenes: { orderBy: { orden: "asc" } } } },
            unidad: true,
            imagenes: { orderBy: { orden: "asc" } },
          },
        },
      },
    });
    return {
      fechaCiclo: aFechaCiclo(lunes),
      ofertas: filas.flatMap((pub) =>
        pub.items.map((item) => ({
          id: item.id,
          fkPublicacion: pub.id,
          fkProducto: item.fkProducto,
          nombre: item.producto.nombre,
          descripcion: item.producto.descripcion,
          fkCategoria: item.producto.fkCategoria,
          categoria: item.producto.categoria.nombre,
          abreviatura: item.unidad.abreviatura,
          precio: item.precio.toFixed(2),
          stock: item.stock,
          imagenes: [...item.imagenes, ...item.producto.imagenes].map(aDtoImagenRef),
        })),
      ),
    };
  }),

  // Weekly-item photos: same D-1 adapter flow as the master catalog (productos.ts),
  // targeting producto_imagen.fk_producto_semanal (M-11 XOR). Online-only (binary
  // upload); owned by the item's publication farmer.
  imagenes: router({
    upload: protectedProcedure
      .input(
        z.object({
          fkProductoSemanal: ID,
          fileName: z.string().min(1).max(255),
          mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
          // Multipart uploads (POST /upload/imagenes) bridge into this procedure with
          // the bytes as base64; the wire no longer carries base64 for the web client.
          dataBase64: z.string().min(1),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        asegurarGestion(ctx.user.rol);
        const bytes = decodificarBase64(input.dataBase64);
        asegurarFirmaImagen(bytes, input.mimeType as MimePermitido);
        if (!extensionCoincide(input.fileName, input.mimeType as MimePermitido)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "La extensión del archivo no coincide con su tipo de contenido",
          });
        }
        const item = await ctx.db.productoSemanal.findUnique({
          where: { id: input.fkProductoSemanal },
          include: { publicacion: { select: { fkAgricultor: true, estado: true } } },
        });
        if (!item) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Producto semanal no encontrado" });
        }
        if (ctx.user.rol !== ROLE.ADMIN && item.publicacion.fkAgricultor !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "La publicación no es tuya" });
        }
        if (item.publicacion.estado !== ESTADO_PUBLICACION.BORRADOR) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Las fotos se agregan a publicaciones en borrador",
          });
        }

        // Same adapter-then-tx contract as productos.imagenes.upload (orphan cleanup on
        // tx failure; the partial unique surfaces concurrent-first-upload as one 409).
        const guardado = await ctx.storage.save(
          bytes,
          MIME_PERMITIDOS[input.mimeType as MimePermitido],
        );
        try {
          return await enTransaccionConCambio(
            ctx.db,
            { tablaOrigen: "producto_imagen", operacion: "insert", actor: ctx.user.id },
            async (tx) => {
              const [ultima, total] = await Promise.all([
                tx.productoImagen.findFirst({
                  where: { fkProductoSemanal: input.fkProductoSemanal },
                  orderBy: { orden: "desc" },
                  select: { orden: true },
                }),
                tx.productoImagen.count({ where: { fkProductoSemanal: input.fkProductoSemanal } }),
              ]);
              const fila = await tx.productoImagen.create({
                data: {
                  fkProductoSemanal: input.fkProductoSemanal,
                  storageKey: guardado.storageKey,
                  url: guardado.url,
                  orden: (ultima?.orden ?? -1) + 1,
                  principal: total === 0,
                },
              });
              return {
                idFila: fila.id,
                valor: {
                  id: fila.id,
                  fkProductoSemanal: fila.fkProductoSemanal,
                  url: fila.url,
                  orden: fila.orden,
                  principal: fila.principal,
                  version: fila.version,
                  actualizadoEn: fila.actualizadoEn.toISOString(),
                },
              };
            },
          );
        } catch (error) {
          await ctx.storage.remove(guardado.storageKey);
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
        asegurarGestion(ctx.user.rol);
        return enTransaccionConCambio(
          ctx.db,
          { tablaOrigen: "producto_imagen", operacion: "update", actor: ctx.user.id },
          async (tx) => {
            const fila = await tx.productoImagen.findUnique({
              where: { id: input.id },
              select: { fkProductoSemanal: true, fkProducto: true },
            });
            if (!fila) throw errorConflictoVersion(input.version, null);
            if (!fila.fkProductoSemanal) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "La imagen no pertenece a un producto semanal",
              });
            }
            const item = await tx.productoSemanal.findUnique({
              where: { id: fila.fkProductoSemanal },
              select: { publicacion: { select: { fkAgricultor: true } } },
            });
            if (ctx.user.rol !== ROLE.ADMIN && item?.publicacion.fkAgricultor !== ctx.user.id) {
              throw new TRPCError({ code: "FORBIDDEN", message: "La publicación no es tuya" });
            }
            // Unset the siblings FIRST (the partial unique demands it) and outbox each
            // affected row — the outbox is the only change-delivery channel.
            const otras = await tx.productoImagen.findMany({
              where: {
                fkProductoSemanal: fila.fkProductoSemanal,
                principal: true,
                id: { not: input.id },
              },
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
            return {
              idFila: actualizada.id,
              valor: {
                id: actualizada.id,
                fkProductoSemanal: actualizada.fkProductoSemanal,
                url: actualizada.url,
                orden: actualizada.orden,
                principal: actualizada.principal,
                version: actualizada.version,
                actualizadoEn: actualizada.actualizadoEn.toISOString(),
              },
            };
          },
        );
      }),

    // Weekly-item photo delete (roadmap §7 gap 7): same D-1 contract as
    // productos.imagenes.delete — physical row delete (hard delete is THE removal
    // path for images), best-effort storage unlink after the tx, and the gap-4
    // auto-promotion of the next principal in the same tx. Guards mirror
    // setPrincipal: gestion roles + the publication's farmer ownership (Admin: any).
    delete: protectedProcedure
      .input(z.object({ id: ID, version: VERSION }))
      .mutation(async ({ input, ctx }) => {
        asegurarGestion(ctx.user.rol);
        const { storageKey } = await enTransaccionConCambio(
          ctx.db,
          { tablaOrigen: "producto_imagen", operacion: "delete", actor: ctx.user.id },
          async (tx) => {
            const fila = await tx.productoImagen.findUnique({
              where: { id: input.id },
              select: { storageKey: true, fkProductoSemanal: true, principal: true },
            });
            if (!fila) throw errorConflictoVersion(input.version, null);
            if (!fila.fkProductoSemanal) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "La imagen no pertenece a un producto semanal",
              });
            }
            const item = await tx.productoSemanal.findUnique({
              where: { id: fila.fkProductoSemanal },
              select: { publicacion: { select: { fkAgricultor: true } } },
            });
            if (ctx.user.rol !== ROLE.ADMIN && item?.publicacion.fkAgricultor !== ctx.user.id) {
              throw new TRPCError({ code: "FORBIDDEN", message: "La publicación no es tuya" });
            }
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
            // Gap 4 auto-promotion within the weekly item (same tx, own outbox row):
            // the old principal row is already deleted, so the partial unique holds.
            if (fila.principal) {
              const siguiente = await tx.productoImagen.findFirst({
                where: { fkProductoSemanal: fila.fkProductoSemanal },
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
            return { idFila: input.id, valor: { storageKey: fila.storageKey } };
          },
        );
        // After the tx commits: best-effort unlink (productos.ts parity).
        await ctx.storage.remove(storageKey);
        return { ok: true };
      }),
  }),
});
