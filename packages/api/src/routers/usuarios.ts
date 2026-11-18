import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Database, Prisma } from "@rassa-jala/db";

import { ROLE } from "../context";
import { protectedProcedure, publicProcedure, router } from "../index";

// P0 Usuarios y roles (docs/scope.md §3.1 — CORREGIR: F-26 role vocabulary, Q-05/Q-06
// provisioning; Q-07 credential flows). Normative sources: docs/database.md §3.1
// (roles/persona/usuario rows, active-localidad semantics), §6.2 (usuarios scoping),
// docs/architecture.md §7 (server-side authorization, no credentials in the frontend).
//
// Mutation pattern (same as catalogos.ts/familias.ts): every mutation writes its row(s)
// plus one sync_cambio row per affected table (M-1a outbox) in a SINGLE Prisma
// transaction, actor = authenticated user id ("dev-seed" never appears here).
//
// Business rules (scope.md §3.2 Q-05/Q-07, decisions 2026-11-17):
// - register is PUBLIC and always creates an active Cliente (nobody self-escalates).
// - Vendedor/Agricultor (and Admin) are provisioned by Admin only.
// - No email flows: admin provisioning/reset returns a generated password ONCE
//   (passwordInicial); it is never logged nor persisted — only its Argon2id hash.
// - Admin-created/reset passwords always set debe_cambiar_password=true (Q-07): even
//   when the admin typed an explicit password, the user must own their credentials via
//   the forced-change gate (protectedProcedure allowlist).
// - Guards: no self role-change, no self state-change, last-active-Admin protection
//   (409) with immediate refresh-token revocation on deactivation/reset.

const CORREO = z.email();
const NOMBRE = z.string().min(1).max(150);
const ID = z.uuid();
// Same policy as auth.changePassword (the only documented password rule so far).
const PASSWORD = z.string().min(6).max(200);
// F-26: the canonical vocabulary is the DB rows (seed: Admin/Agricultor/Vendedor/Cliente);
// ROLE (context.ts) mirrors them as the single source of truth for code.
const ROL = z.enum([ROLE.ADMIN, ROLE.AGRICULTOR, ROLE.VENDEDOR, ROLE.CLIENTE]);

type OperacionOutbox = "insert" | "update";

// M-1a: outbox rows ride in the SAME transaction as the row writes.
async function escribirCambios(
  tx: Prisma.TransactionClient,
  actor: string,
  cambios: Array<{ tablaOrigen: string; idFila: string; operacion: OperacionOutbox }>,
): Promise<void> {
  if (cambios.length === 0) return;
  await tx.syncCambio.createMany({ data: cambios.map((c) => ({ ...c, actor })) });
}

function asegurarAdmin(rol: string): void {
  if (rol !== ROLE.ADMIN) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Solo el rol Admin puede administrar usuarios",
    });
  }
}

// database.md §3.1: persona.fk_localidad must reference an ACTIVE localidad (soft-delete
// semantics); an inactive/missing row is a client error with one clear message.
async function asegurarLocalidadActiva(
  tx: Prisma.TransactionClient,
  fkLocalidad: string,
): Promise<void> {
  const localidad = await tx.localidad.findUnique({
    where: { id: fkLocalidad },
    select: { estado: true },
  });
  if (!localidad?.estado) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "La localidad seleccionada no está disponible",
    });
  }
}

// Q-07: 12-char password from crypto randomness (no ambiguous glyphs); returned ONCE by
// create/resetPassword and immediately hashed — never logged nor stored in plaintext.
function generarPassword(): string {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => alfabeto[b % alfabeto.length]).join("");
}

function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

function errorCorreoDuplicado(): TRPCError {
  return new TRPCError({ code: "CONFLICT", message: "El correo ya está registrado" });
}

// A concurrent insert can still hit usuario.correo UNIQUE; map any P2002 on it to 409.
function esViolacionCorreoUnico(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: string }).code !== "P2002") return false;
  return JSON.stringify((error as { meta?: unknown }).meta ?? "").includes("correo");
}

// ---- DTO shapes (dates ISO 8601; never includes passwordHash — S4, database.md §6.3.7) ----

interface UsuarioListaDto {
  id: string;
  correo: string;
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  fkLocalidad: string | null;
  rol: string;
  estado: boolean;
  version: number;
  debeCambiarPassword: boolean;
  familiaNombre: string | null;
  tieneLimite: boolean;
}

// ---- shared loaders ----

type OpcionesLista = {
  search?: string;
  rol?: string;
  estado?: boolean;
};

async function cargarLista(
  db: Database,
  opciones: OpcionesLista,
  pagina: { page: number; pageSize: number },
) {
  const busqueda = opciones.search?.trim();
  const where: Prisma.UsuarioWhereInput = {
    ...(opciones.estado === undefined ? {} : { estado: opciones.estado }),
    ...(opciones.rol ? { rol: { nombre: opciones.rol } } : {}),
    ...(busqueda
      ? {
          OR: [
            { correo: { contains: busqueda, mode: "insensitive" } },
            { persona: { nombre: { contains: busqueda, mode: "insensitive" } } },
            { persona: { apellidoPaterno: { contains: busqueda, mode: "insensitive" } } },
            { persona: { apellidoMaterno: { contains: busqueda, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [filas, total] = await Promise.all([
    db.usuario.findMany({
      where,
      include: { persona: true, rol: true },
      orderBy: { correo: "asc" },
      skip: (pagina.page - 1) * pagina.pageSize,
      take: pagina.pageSize,
    }),
    db.usuario.count({ where }),
  ]);
  const ids = filas.map((f) => f.id);
  const [membresias, limites] = await Promise.all([
    ids.length
      ? db.familiaUsuario.findMany({
          where: { fkUsuario: { in: ids }, estado: true },
          include: { familia: { select: { nombre: true } } },
        })
      : Promise.resolve([]),
    ids.length
      ? db.limiteCredito.findMany({
          where: { fkUsuario: { in: ids } },
          select: { fkUsuario: true },
        })
      : Promise.resolve([]),
  ]);
  const familiaPorUsuario = new Map(membresias.map((m) => [m.fkUsuario, m.familia.nombre]));
  const conLimite = new Set(limites.map((l) => l.fkUsuario));
  const usuarios: UsuarioListaDto[] = filas.map((f) => ({
    id: f.id,
    correo: f.correo,
    nombre: f.persona.nombre,
    apellidoPaterno: f.persona.apellidoPaterno,
    apellidoMaterno: f.persona.apellidoMaterno,
    fkLocalidad: f.persona.fkLocalidad,
    rol: f.rol.nombre,
    estado: f.estado,
    version: f.version,
    debeCambiarPassword: f.debeCambiarPassword,
    familiaNombre: familiaPorUsuario.get(f.id) ?? null,
    tieneLimite: conLimite.has(f.id),
  }));
  return { usuarios, total };
}

// ---- procedures ----

export const usuariosRouter = router({
  // Q-05: public registration always creates an active Cliente (no self-escalation).
  // Online-confirm flow: the new user logs in afterwards (no session is issued here).
  register: publicProcedure
    .input(
      z.object({
        email: CORREO,
        password: PASSWORD,
        nombre: NOMBRE,
        apellidoPaterno: NOMBRE,
        apellidoMaterno: NOMBRE.optional(),
        fkLocalidad: ID,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const correo = input.email.trim().toLowerCase();
      try {
        return await ctx.db.$transaction(async (tx) => {
          await asegurarLocalidadActiva(tx, input.fkLocalidad);
          const rolCliente = await tx.rol.findUnique({ where: { nombre: ROLE.CLIENTE } });
          if (!rolCliente) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "El rol Cliente no está configurado en el catálogo",
            });
          }
          const duplicado = await tx.usuario.findUnique({
            where: { correo },
            select: { id: true },
          });
          if (duplicado) throw errorCorreoDuplicado();
          const persona = await tx.persona.create({
            data: {
              nombre: input.nombre.trim(),
              apellidoPaterno: input.apellidoPaterno.trim(),
              apellidoMaterno: input.apellidoMaterno?.trim() || null,
              fkLocalidad: input.fkLocalidad,
            },
          });
          const usuario = await tx.usuario.create({
            data: {
              correo,
              passwordHash: await hashPassword(input.password),
              fkPersona: persona.id,
              fkRol: rolCliente.id,
              estado: true,
              debeCambiarPassword: false,
            },
          });
          await escribirCambios(tx, usuario.id, [
            { tablaOrigen: "persona", idFila: persona.id, operacion: "insert" },
            { tablaOrigen: "usuario", idFila: usuario.id, operacion: "insert" },
          ]);
          return { ok: true, correo: usuario.correo };
        });
      } catch (error) {
        if (esViolacionCorreoUnico(error)) throw errorCorreoDuplicado();
        throw error;
      }
    }),

  // ---- Admin management (online-confirm; the scoped PULL collection serves rosters) ----

  list: protectedProcedure
    .input(
      z.object({
        search: z.string().max(150).optional(),
        rol: ROL.optional(),
        estado: z.boolean().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      return cargarLista(ctx.db, input, { page: input.page, pageSize: input.pageSize });
    }),

  detail: protectedProcedure.input(z.object({ id: ID })).query(async ({ input, ctx }) => {
    asegurarAdmin(ctx.user.rol);
    const usuario = await ctx.db.usuario.findUnique({
      where: { id: input.id },
      include: { persona: true, rol: true },
    });
    if (!usuario) {
      throw new TRPCError({ code: "NOT_FOUND", message: "El usuario no existe" });
    }
    const [membresia, limite] = await Promise.all([
      ctx.db.familiaUsuario.findFirst({
        where: { fkUsuario: usuario.id, estado: true },
        include: { familia: { select: { nombre: true } } },
      }),
      ctx.db.limiteCredito.findFirst({ where: { fkUsuario: usuario.id } }),
    ]);
    return {
      id: usuario.id,
      correo: usuario.correo,
      nombre: usuario.persona.nombre,
      apellidoPaterno: usuario.persona.apellidoPaterno,
      apellidoMaterno: usuario.persona.apellidoMaterno,
      fkLocalidad: usuario.persona.fkLocalidad,
      rol: usuario.rol.nombre,
      estado: usuario.estado,
      version: usuario.version,
      debeCambiarPassword: usuario.debeCambiarPassword,
      familiaNombre: membresia?.familia.nombre ?? null,
      tieneLimite: limite != null,
    } satisfies UsuarioListaDto;
  }),

  // Q-05/Q-07: Admin provisioning. The generated password (or the explicit one) is
  // delivered hashed-only; when generated, passwordInicial comes back ONCE.
  create: protectedProcedure
    .input(
      z
        .object({
          email: CORREO,
          password: PASSWORD.optional(),
          generate: z.boolean().optional(),
          rol: ROL,
          nombre: NOMBRE,
          apellidoPaterno: NOMBRE,
          apellidoMaterno: NOMBRE.optional(),
          fkLocalidad: ID.optional(),
        })
        .superRefine((datos, ctxZod) => {
          if (datos.password && datos.generate) {
            ctxZod.addIssue({
              code: "custom",
              message: "Indique una contraseña o solicite su generación, no ambas",
            });
          }
          if (!datos.password && !datos.generate) {
            ctxZod.addIssue({
              code: "custom",
              message: "Indique una contraseña o solicite su generación",
            });
          }
        }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const correo = input.email.trim().toLowerCase();
      const generada = !input.password;
      const passwordPlano = input.password ?? generarPassword();
      try {
        const usuario = await ctx.db.$transaction(async (tx) => {
          if (input.fkLocalidad) await asegurarLocalidadActiva(tx, input.fkLocalidad);
          const rol = await tx.rol.findUnique({ where: { nombre: input.rol } });
          if (!rol) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "El rol indicado no existe en el catálogo",
            });
          }
          const duplicado = await tx.usuario.findUnique({
            where: { correo },
            select: { id: true },
          });
          if (duplicado) throw errorCorreoDuplicado();
          const persona = await tx.persona.create({
            data: {
              nombre: input.nombre.trim(),
              apellidoPaterno: input.apellidoPaterno.trim(),
              apellidoMaterno: input.apellidoMaterno?.trim() || null,
              ...(input.fkLocalidad ? { fkLocalidad: input.fkLocalidad } : {}),
            },
          });
          const nuevo = await tx.usuario.create({
            data: {
              correo,
              passwordHash: await hashPassword(passwordPlano),
              fkPersona: persona.id,
              fkRol: rol.id,
              estado: true,
              // Q-07: the user must own their credentials; the forced-change gate holds
              // until auth.changePassword clears the flag (even with an explicit password).
              debeCambiarPassword: true,
            },
          });
          await escribirCambios(tx, ctx.user.id, [
            { tablaOrigen: "persona", idFila: persona.id, operacion: "insert" },
            { tablaOrigen: "usuario", idFila: nuevo.id, operacion: "insert" },
          ]);
          return nuevo;
        });
        return {
          id: usuario.id,
          correo: usuario.correo,
          rol: input.rol,
          debeCambiarPassword: true,
          ...(generada ? { passwordInicial: passwordPlano } : {}),
        };
      } catch (error) {
        if (esViolacionCorreoUnico(error)) throw errorCorreoDuplicado();
        throw error;
      }
    }),

  // F-26: role assignment stays Admin-only; nobody changes their own role.
  changeRol: protectedProcedure
    .input(z.object({ id: ID, rol: ROL }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      if (input.id === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "No puedes cambiar tu propio rol" });
      }
      await ctx.db.$transaction(async (tx) => {
        // Serialize admin-integrity transitions (setEstado shares this lock):
        // concurrent role/state changes must not both pass the last-active-Admin
        // count (pg_advisory_xact_lock pattern, same family as the folio locks).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('usuarios_admin_integridad'))`;
        const usuario = await tx.usuario.findUnique({
          where: { id: input.id },
          select: { id: true, estado: true, rol: { select: { nombre: true } } },
        });
        if (!usuario) {
          throw new TRPCError({ code: "NOT_FOUND", message: "El usuario no existe" });
        }
        const rol = await tx.rol.findUnique({ where: { nombre: input.rol }, select: { id: true } });
        if (!rol) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "El rol indicado no existe en el catálogo",
          });
        }
        // Last-active-Admin guard: degrading the only active Admin would lock
        // admin operations out of the system entirely.
        if (usuario.estado && usuario.rol.nombre === ROLE.ADMIN && input.rol !== ROLE.ADMIN) {
          const adminsActivos = await tx.usuario.count({
            where: { estado: true, rol: { nombre: ROLE.ADMIN } },
          });
          if (adminsActivos <= 1) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Debe existir al menos un Admin activo",
            });
          }
        }
        await tx.usuario.update({
          where: { id: usuario.id },
          data: { fkRol: rol.id, version: { increment: 1 } },
        });
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "usuario", idFila: usuario.id, operacion: "update" },
        ]);
      });
      // Role freshness: protectedProcedure overwrites ctx.user.rol from the DB on
      // every protected call, so a downgraded user loses admin powers immediately
      // (the JWT claim no longer authorizes anything by itself).
      return { ok: true };
    }),

  // Deactivation closes the session family in the SAME transaction (revoked_at=now on
  // every refresh_token row); protectedProcedure's per-call estado check rejects the
  // still-valid access token immediately (F-01 fix semantics).
  setEstado: protectedProcedure
    .input(z.object({ id: ID, estado: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      if (input.id === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "No puedes cambiar tu propio estado" });
      }
      await ctx.db.$transaction(async (tx) => {
        // Serialize with changeRol: two concurrent transitions must not both
        // pass the last-active-Admin count (pg_advisory_xact_lock pattern).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('usuarios_admin_integridad'))`;
        const usuario = await tx.usuario.findUnique({
          where: { id: input.id },
          include: { rol: { select: { nombre: true } } },
        });
        if (!usuario) {
          throw new TRPCError({ code: "NOT_FOUND", message: "El usuario no existe" });
        }
        if (!input.estado && usuario.estado && usuario.rol.nombre === ROLE.ADMIN) {
          const adminsActivos = await tx.usuario.count({
            where: { estado: true, rol: { nombre: ROLE.ADMIN } },
          });
          if (adminsActivos <= 1) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Debe existir al menos un Admin activo",
            });
          }
        }
        await tx.usuario.update({
          where: { id: usuario.id },
          data: { estado: input.estado, version: { increment: 1 } },
        });
        if (!input.estado && usuario.estado) {
          await tx.refreshToken.updateMany({
            where: { fkUsuario: usuario.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "usuario", idFila: usuario.id, operacion: "update" },
        ]);
      });
      return { ok: true };
    }),

  // Admin reset: new hash + forced change + full session revocation. The generated
  // password is returned ONCE (passwordInicial) and never persisted in plaintext.
  resetPassword: protectedProcedure
    .input(
      z
        .object({
          id: ID,
          password: PASSWORD.optional(),
          generate: z.boolean().optional(),
        })
        .superRefine((datos, ctxZod) => {
          if (datos.password && datos.generate) {
            ctxZod.addIssue({
              code: "custom",
              message: "Indique una contraseña o solicite su generación, no ambas",
            });
          }
          if (!datos.password && !datos.generate) {
            ctxZod.addIssue({
              code: "custom",
              message: "Indique una contraseña o solicite su generación",
            });
          }
        }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const generada = !input.password;
      const passwordPlano = input.password ?? generarPassword();
      await ctx.db.$transaction(async (tx) => {
        const usuario = await tx.usuario.findUnique({
          where: { id: input.id },
          select: { id: true },
        });
        if (!usuario) {
          throw new TRPCError({ code: "NOT_FOUND", message: "El usuario no existe" });
        }
        await tx.usuario.update({
          where: { id: usuario.id },
          data: {
            passwordHash: await hashPassword(passwordPlano),
            debeCambiarPassword: true,
            version: { increment: 1 },
          },
        });
        await tx.refreshToken.updateMany({
          where: { fkUsuario: usuario.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "usuario", idFila: usuario.id, operacion: "update" },
        ]);
      });
      return { ok: true, ...(generada ? { passwordInicial: passwordPlano } : {}) };
    }),

  // Self-service profile edit (authenticated, NOT Admin-only): own persona fields only —
  // email/rol/estado are not editable here by design (Q-05: nobody self-escalates).
  updatePerfil: protectedProcedure
    .input(
      z
        .object({
          nombre: NOMBRE.optional(),
          apellidoPaterno: NOMBRE.optional(),
          apellidoMaterno: NOMBRE.optional(),
          fkLocalidad: ID.optional(),
        })
        .refine((datos) => Object.values(datos).some((v) => v !== undefined), {
          message: "Indique al menos un campo a actualizar",
        }),
    )
    .mutation(async ({ input, ctx }) => {
      const usuario = await ctx.db.usuario.findUnique({
        where: { id: ctx.user.id },
        select: { fkPersona: true },
      });
      if (!usuario) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "No autenticado" });
      }
      const persona = await ctx.db.$transaction(async (tx) => {
        if (input.fkLocalidad) await asegurarLocalidadActiva(tx, input.fkLocalidad);
        const actualizada = await tx.persona.update({
          where: { id: usuario.fkPersona },
          data: {
            ...(input.nombre !== undefined ? { nombre: input.nombre.trim() } : {}),
            ...(input.apellidoPaterno !== undefined
              ? { apellidoPaterno: input.apellidoPaterno.trim() }
              : {}),
            ...(input.apellidoMaterno !== undefined
              ? { apellidoMaterno: input.apellidoMaterno.trim() || null }
              : {}),
            ...(input.fkLocalidad ? { fkLocalidad: input.fkLocalidad } : {}),
            version: { increment: 1 },
          },
        });
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "persona", idFila: actualizada.id, operacion: "update" },
        ]);
        return actualizada;
      });
      return {
        nombre: persona.nombre,
        apellidoPaterno: persona.apellidoPaterno,
        apellidoMaterno: persona.apellidoMaterno,
        fkLocalidad: persona.fkLocalidad,
      };
    }),
});
