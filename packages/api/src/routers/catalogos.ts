import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Database, Prisma } from "@rassa-jala/db";

import { ROLE, type Role } from "../context";
import { protectedProcedure, publicProcedure, router } from "../index";

// Online admin CRUD for the four S1 catalogs (docs/scope.md §3.1 "Catálogos — COMPLETAR").
// Normative sources: docs/synchronization.md §6/§9 (catalog writes are online-confirm
// mutations; S1 has NO raw doc push in production) and docs/database.md §3/§6.2 (M-1a
// outbox, §6.3.6 soft-delete). The patterns are the SAME as sync.ts's push:
// - every mutation writes the row + one sync_cambio row in a SINGLE Prisma transaction
//   (M-1a), with actor = authenticated user id;
// - update/setEstado compare-and-set `version` via updateMany (SP-2): 0 rows → CONFLICT;
// - mutations are Admin-only (legacy IsAdminOrReadOnly semantics, data-driven role);
// - `list` is any authenticated user (S1 global scoping, database.md §6.2).
//
// Deliberate scope decisions:
// - NO permanent-delete procedure exists: catalog rows with FK children (municipios →
//   localidades, localidades → personas; categoria/unidad → producto PROTECT) are
//   soft-delete only, mirroring legacy trash/restore. estado=false reaches clients as
//   _deleted=true via PULL (synchronization.md §8); the outbox operacion is 'update'.
// - Deactivating a municipio does NOT cascade to its localidades: rows are managed
//   independently and clients receive per-row states via PULL.
// - Rows are created with the schema's version default (1) — the same value sync.ts push
//   creates use — so a later offline push can CAS them (versionAsumida is z-positive).
// - slice.prisma has NO unique constraint on nombre (only legacy_id is unique), so
//   uniqueness is enforced in code inside the mutation transaction, estado-agnostic: a
//   trashed name cannot be re-created, restore is the way back. Scope: nombre is unique
//   per municipio for localidad, global for the other three. Residual race: without a DB
//   constraint two concurrent creates could still commit the same name; the in-tx check
//   only narrows the window (schema is frozen — no index may be added here).
// - setEstado adds no extra domain guard (keep minimal): restoring a localidad whose
//   municipio is inactive is permitted; clients see each row's own state via PULL.

const TABLAS = {
  municipios: "municipio",
  localidades: "localidad",
  categorias: "categoria_producto",
  unidades: "unidad",
} as const;

// slice-decision: max length 150 = legacy's longest catalog nombre (localidad, DA §2);
// slice.prisma uses text columns with no length limits.
const NOMBRE = z.string().min(1).max(150);
const ID = z.uuid();
const VERSION = z.number().int().positive();
const TEXTO_OPCIONAL = z.string().max(150).nullish();

// ---- DTO shapes returned to clients (dates ISO 8601, database.md §6.3) ----

interface MunicipioDto {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
}

interface LocalidadDto extends MunicipioDto {
  fkMunicipio: string;
}

interface CategoriaDto {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
}

interface UnidadDto {
  id: string;
  // Legacy-compat nullable columns (DA §8.4): legacy unidad rows may carry a null
  // nombre (display falls back to tipo/abreviatura, models.py Unidad.__str__).
  nombre: string | null;
  tipo: string | null;
  abreviatura: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
}

type FilaMunicipio = Awaited<ReturnType<Database["municipio"]["findMany"]>>[number];
type FilaLocalidad = Awaited<ReturnType<Database["localidad"]["findMany"]>>[number];
type FilaCategoria = Awaited<ReturnType<Database["categoriaProducto"]["findMany"]>>[number];
type FilaUnidad = Awaited<ReturnType<Database["unidad"]["findMany"]>>[number];

function aDtoMunicipio(fila: FilaMunicipio): MunicipioDto {
  return {
    id: fila.id,
    nombre: fila.nombre,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
  };
}

function aDtoLocalidad(fila: FilaLocalidad): LocalidadDto {
  return {
    id: fila.id,
    fkMunicipio: fila.fkMunicipio,
    nombre: fila.nombre,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
  };
}

function aDtoCategoria(fila: FilaCategoria): CategoriaDto {
  return {
    id: fila.id,
    nombre: fila.nombre,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
  };
}

function aDtoUnidad(fila: FilaUnidad): UnidadDto {
  return {
    id: fila.id,
    nombre: fila.nombre,
    tipo: fila.tipo,
    abreviatura: fila.abreviatura,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
  };
}

// ---- shared helpers ----

type OperacionOutbox = "insert" | "update";

// M-1a: the outbox row rides in the SAME transaction as the row write — readers only
// ever see both or neither. The callback returns the affected row id so `insert` can
// target the DB-generated PK.
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
      message: "Solo el rol Admin puede modificar los catálogos",
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

async function asegurarMunicipioActivo(
  tx: Prisma.TransactionClient,
  fkMunicipio: string,
): Promise<void> {
  const municipio = await tx.municipio.findUnique({
    where: { id: fkMunicipio },
    select: { estado: true },
  });
  if (!municipio?.estado) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "El municipio indicado no existe o está inactivo",
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

// ---- procedures ----
// Naming matches the module contract: catalogos.<coleccion><Operación> (flat), plus
// catalogos.<coleccion>List for the admin trash view.

export const catalogosRouter = router({
  // ---- MUNICIPIOS ----

  municipiosList: protectedProcedure
    .input(z.object({ incluirInactivos: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const filas = await ctx.db.municipio.findMany({
        where: input.incluirInactivos ? undefined : { estado: true },
        orderBy: { nombre: "asc" },
      });
      return filas.map(aDtoMunicipio);
    }),

  municipiosCreate: protectedProcedure
    .input(z.object({ nombre: NOMBRE }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.municipios, operacion: "insert", actor: ctx.user.id },
        async (tx) => {
          await asegurarNombreUnico(nombre, "un municipio", () =>
            tx.municipio.findFirst({ where: { nombre }, select: { id: true } }),
          );
          const fila = await tx.municipio.create({ data: { nombre } });
          return { idFila: fila.id, valor: aDtoMunicipio(fila) };
        },
      );
      return valor;
    }),

  municipiosUpdate: protectedProcedure
    .input(z.object({ id: ID, version: VERSION, nombre: NOMBRE }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.municipios, operacion: "update", actor: ctx.user.id },
        async (tx) => {
          await asegurarNombreUnico(nombre, "un municipio", () =>
            tx.municipio.findFirst({
              where: { nombre, id: { not: input.id } },
              select: { id: true },
            }),
          );
          const aplicadas = await tx.municipio.updateMany({
            where: { id: input.id, version: input.version },
            data: { nombre, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.municipio.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          const fila = await tx.municipio.findUniqueOrThrow({ where: { id: input.id } });
          return { idFila: fila.id, valor: aDtoMunicipio(fila) };
        },
      );
      return valor;
    }),

  municipiosSetEstado: protectedProcedure
    .input(z.object({ id: ID, version: VERSION, estado: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.municipios, operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const aplicadas = await tx.municipio.updateMany({
            where: { id: input.id, version: input.version },
            data: { estado: input.estado, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.municipio.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          return { idFila: input.id, valor: { ok: true } };
        },
      );
      return valor;
    }),

  // ---- LOCALIDADES ----

  localidadesList: protectedProcedure
    .input(z.object({ incluirInactivos: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const filas = await ctx.db.localidad.findMany({
        where: input.incluirInactivos ? undefined : { estado: true },
        orderBy: { nombre: "asc" },
      });
      return filas.map(aDtoLocalidad);
    }),

  // PUBLIC read-only picker for the registration form (Q-05): a brand-new visitor has no
  // session, so the authenticated PULL/localidadesList cannot feed the localidad select.
  // Only active rows, minimal fields (no write surface — registration still validates
  // server-side via usuarios.register).
  localidadesPublicas: publicProcedure.query(async ({ ctx }) => {
    const filas = await ctx.db.localidad.findMany({
      where: { estado: true },
      include: { municipio: { select: { nombre: true } } },
      orderBy: { nombre: "asc" },
    });
    return filas.map((fila) => ({
      id: fila.id,
      nombre: fila.nombre,
      municipio: fila.municipio.nombre,
    }));
  }),

  localidadesCreate: protectedProcedure
    .input(z.object({ nombre: NOMBRE, fkMunicipio: ID }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.localidades, operacion: "insert", actor: ctx.user.id },
        async (tx) => {
          // FK existence + active parent, before any write (same domain-rule-first
          // order as sync.ts §5.2 steps 3–4).
          await asegurarMunicipioActivo(tx, input.fkMunicipio);
          await asegurarNombreUnico(nombre, "una localidad en ese municipio", () =>
            tx.localidad.findFirst({
              where: { nombre, fkMunicipio: input.fkMunicipio },
              select: { id: true },
            }),
          );
          const fila = await tx.localidad.create({
            data: { nombre, fkMunicipio: input.fkMunicipio },
          });
          return { idFila: fila.id, valor: aDtoLocalidad(fila) };
        },
      );
      return valor;
    }),

  localidadesUpdate: protectedProcedure
    .input(z.object({ id: ID, version: VERSION, nombre: NOMBRE, fkMunicipio: ID.optional() }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.localidades, operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const actual = await tx.localidad.findUnique({
            where: { id: input.id },
            select: { fkMunicipio: true },
          });
          if (!actual) {
            throw errorConflictoVersion(input.version, null);
          }
          const fkMunicipio = input.fkMunicipio ?? actual.fkMunicipio;
          if (input.fkMunicipio !== undefined) {
            await asegurarMunicipioActivo(tx, fkMunicipio);
          }
          await asegurarNombreUnico(nombre, "una localidad en ese municipio", () =>
            tx.localidad.findFirst({
              where: { nombre, fkMunicipio, id: { not: input.id } },
              select: { id: true },
            }),
          );
          const aplicadas = await tx.localidad.updateMany({
            where: { id: input.id, version: input.version },
            data: {
              nombre,
              ...(input.fkMunicipio !== undefined ? { fkMunicipio: input.fkMunicipio } : {}),
              version: { increment: 1 },
            },
          });
          if (aplicadas.count === 0) {
            const vigente = await tx.localidad.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, vigente?.version ?? null);
          }
          const fila = await tx.localidad.findUniqueOrThrow({ where: { id: input.id } });
          return { idFila: fila.id, valor: aDtoLocalidad(fila) };
        },
      );
      return valor;
    }),

  localidadesSetEstado: protectedProcedure
    .input(z.object({ id: ID, version: VERSION, estado: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.localidades, operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const aplicadas = await tx.localidad.updateMany({
            where: { id: input.id, version: input.version },
            data: { estado: input.estado, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.localidad.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          return { idFila: input.id, valor: { ok: true } };
        },
      );
      return valor;
    }),

  // ---- CATEGORÍAS ----

  categoriasList: protectedProcedure
    .input(z.object({ incluirInactivos: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const filas = await ctx.db.categoriaProducto.findMany({
        where: input.incluirInactivos ? undefined : { estado: true },
        orderBy: { nombre: "asc" },
      });
      return filas.map(aDtoCategoria);
    }),

  categoriasCreate: protectedProcedure
    .input(z.object({ nombre: NOMBRE }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.categorias, operacion: "insert", actor: ctx.user.id },
        async (tx) => {
          await asegurarNombreUnico(nombre, "una categoría", () =>
            tx.categoriaProducto.findFirst({ where: { nombre }, select: { id: true } }),
          );
          const fila = await tx.categoriaProducto.create({ data: { nombre } });
          return { idFila: fila.id, valor: aDtoCategoria(fila) };
        },
      );
      return valor;
    }),

  categoriasUpdate: protectedProcedure
    .input(z.object({ id: ID, version: VERSION, nombre: NOMBRE }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.categorias, operacion: "update", actor: ctx.user.id },
        async (tx) => {
          await asegurarNombreUnico(nombre, "una categoría", () =>
            tx.categoriaProducto.findFirst({
              where: { nombre, id: { not: input.id } },
              select: { id: true },
            }),
          );
          const aplicadas = await tx.categoriaProducto.updateMany({
            where: { id: input.id, version: input.version },
            data: { nombre, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.categoriaProducto.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          const fila = await tx.categoriaProducto.findUniqueOrThrow({
            where: { id: input.id },
          });
          return { idFila: fila.id, valor: aDtoCategoria(fila) };
        },
      );
      return valor;
    }),

  categoriasSetEstado: protectedProcedure
    .input(z.object({ id: ID, version: VERSION, estado: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.categorias, operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const aplicadas = await tx.categoriaProducto.updateMany({
            where: { id: input.id, version: input.version },
            data: { estado: input.estado, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.categoriaProducto.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          return { idFila: input.id, valor: { ok: true } };
        },
      );
      return valor;
    }),

  // ---- UNIDADES ----

  unidadesList: protectedProcedure
    .input(z.object({ incluirInactivos: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const filas = await ctx.db.unidad.findMany({
        where: input.incluirInactivos ? undefined : { estado: true },
        orderBy: { nombre: "asc" },
      });
      return filas.map(aDtoUnidad);
    }),

  unidadesCreate: protectedProcedure
    .input(z.object({ nombre: NOMBRE, tipo: TEXTO_OPCIONAL, abreviatura: TEXTO_OPCIONAL }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.unidades, operacion: "insert", actor: ctx.user.id },
        async (tx) => {
          await asegurarNombreUnico(nombre, "una unidad", () =>
            tx.unidad.findFirst({ where: { nombre }, select: { id: true } }),
          );
          const fila = await tx.unidad.create({
            data: {
              nombre,
              tipo: textoOpcional(input.tipo),
              abreviatura: textoOpcional(input.abreviatura),
            },
          });
          return { idFila: fila.id, valor: aDtoUnidad(fila) };
        },
      );
      return valor;
    }),

  unidadesUpdate: protectedProcedure
    .input(
      z.object({
        id: ID,
        version: VERSION,
        nombre: NOMBRE,
        // Absent → unchanged; present (even null/empty) → set/clear the nullable column.
        tipo: TEXTO_OPCIONAL,
        abreviatura: TEXTO_OPCIONAL,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = nombreNormalizado(input.nombre);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.unidades, operacion: "update", actor: ctx.user.id },
        async (tx) => {
          await asegurarNombreUnico(nombre, "una unidad", () =>
            tx.unidad.findFirst({
              where: { nombre, id: { not: input.id } },
              select: { id: true },
            }),
          );
          const aplicadas = await tx.unidad.updateMany({
            where: { id: input.id, version: input.version },
            data: {
              nombre,
              ...(input.tipo !== undefined ? { tipo: textoOpcional(input.tipo) } : {}),
              ...(input.abreviatura !== undefined
                ? { abreviatura: textoOpcional(input.abreviatura) }
                : {}),
              version: { increment: 1 },
            },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.unidad.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          const fila = await tx.unidad.findUniqueOrThrow({ where: { id: input.id } });
          return { idFila: fila.id, valor: aDtoUnidad(fila) };
        },
      );
      return valor;
    }),

  unidadesSetEstado: protectedProcedure
    .input(z.object({ id: ID, version: VERSION, estado: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const valor = await enTransaccionConCambio(
        ctx.db,
        { tablaOrigen: TABLAS.unidades, operacion: "update", actor: ctx.user.id },
        async (tx) => {
          const aplicadas = await tx.unidad.updateMany({
            where: { id: input.id, version: input.version },
            data: { estado: input.estado, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            const actual = await tx.unidad.findUnique({
              where: { id: input.id },
              select: { version: true },
            });
            throw errorConflictoVersion(input.version, actual?.version ?? null);
          }
          return { idFila: input.id, valor: { ok: true } };
        },
      );
      return valor;
    }),
});
