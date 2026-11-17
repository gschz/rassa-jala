import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Database, Prisma } from "@rassa-jala/db";

import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";

// P0 Familias y permisos (docs/scope.md §3.1 — CONSERVAR reforzado; F-09/Q-21 memberships,
// Q-10 credit limits). Normative sources: docs/database.md §3.1 rows, §4.2 partial uniques,
// §6.2 scoping, §7.1 M-8/M-9. The mutation pattern is the SAME as catalogos.ts/sync.ts:
// - every mutation writes its row(s) + one sync_cambio row per affected table in a SINGLE
//   Prisma transaction (M-1a), actor = authenticated user id;
// - updates compare-and-set `version` via updateMany (SP-2): 0 rows → CONFLICT;
// - mutations are Admin-only (legacy IsAdminOrReadOnly semantics); `list` is any
//   authenticated user, scoped (admin → all; others → own active family only);
// - one-active-membership is enforced by BOTH the server pre-check inside the tx AND the
//   DB partial unique "familia_usuario_fk_usuario_activo_key" (Q-21): a P2002 on that
//   index → 409 'El usuario ya pertenece a una familia activa' (concurrent-safe).
// doc-deviation: database.md §6.2 maps ONE RxDB collection `familias` to
// familia+familia_usuario; the implementation ships THREE PULL collections (`familias`,
// `membresias`, `limites_credito`) because member scoping per identity (sync doc §11)
// needs each user's own membership rows instead of a roster embedded in family docs.
// Recorded in database.md §6.2 and justified in §7.1 M-9.
//
// Deliberate scope decisions:
// - NO dissolve procedure beyond setEstado: family soft-delete cascades (memberships +
//   conversation deactivated; restore reactivates them, skipping members who joined
//   another family meanwhile — reported to the caller).
// - removeMember deletes the family-conversation integrantes row (integrantes has a plain
//   UNIQUE pair and NO estado column per database.md §3.1): deleting is reversible by
//   re-insert on restoreMember.
// - limite_credito is upserted BY OWNER (the per-owner partial uniques guarantee at most
//   one row, any estado); setLimite reactivates an existing row instead of inserting.
// - conversacion creation is idempotent against the partial unique
//   "conversacion_fk_familia_activa_key" via INSERT ... ON CONFLICT DO NOTHING + re-read.

const NOMBRE = z.string().min(1).max(150);
const ID = z.uuid();
const VERSION = z.number().int().positive();
// numeric(12,2): 10 integer digits + 2 decimals; >= 0 (Q-10; DB CHECK backstop, M-8).
const MONTO = z.number().min(0).max(9_999_999_999.99);
const CORREO = z.email();

// ---- DB row types ----

type FilaFamilia = Awaited<ReturnType<Database["familia"]["findMany"]>>[number];
type FilaMembresia = Awaited<ReturnType<Database["familiaUsuario"]["findMany"]>>[number];
type FilaLimite = Awaited<ReturnType<Database["limiteCredito"]["findMany"]>>[number];
type FilaUsuario = Awaited<ReturnType<Database["usuario"]["findMany"]>>[number];

// ---- DTO shapes returned to clients (money as string, dates ISO 8601, database.md §6.3) ----

interface MiembroDto {
  membresiaId: string;
  usuarioId: string;
  correo: string;
  esJefe: boolean;
  estado: boolean;
  version: number;
}

interface LimiteDto {
  id: string;
  monto: string;
  estado: boolean;
  version: number;
}

interface FamiliaDto {
  id: string;
  nombre: string;
  fkJefeUsuario: string | null;
  estado: boolean;
  version: number;
  limite: LimiteDto | null;
  miembros: MiembroDto[];
}

interface MembresiaDto {
  id: string;
  fkUsuario: string;
  fkFamilia: string;
  estado: boolean;
  version: number;
}

interface LimiteRespuestaDto {
  id: string;
  monto: string;
  fkFamilia: string | null;
  fkUsuario: string | null;
  estado: boolean;
  version: number;
}

// ---- shared helpers ----

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

function asegurarAdmin(rol: Role): void {
  if (rol !== ROLE.ADMIN) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Solo el rol Admin puede modificar las familias",
    });
  }
}

// Q-21: the partial unique index makes double-active impossible at the DB level; any
// P2002 on it maps to one clear 409 (covers both "already in THIS family" and "active in
// another family" reached through a race).
const INDICE_MEMBRESIA_ACTIVA = "familia_usuario_fk_usuario_activo_key";

function esViolacionMembresiaActiva(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const codigo = (error as { code?: string }).code;
  if (codigo !== "P2002") return false;
  const meta = JSON.stringify((error as { meta?: unknown }).meta ?? "");
  return meta.includes(INDICE_MEMBRESIA_ACTIVA);
}

function errorMembresiaActiva(): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: "El usuario ya pertenece a una familia activa",
  });
}

// DB CHECK violations (M-8: monto >= 0, owner XOR) surface as Prisma P2004 — a clean 400.
function esViolacionChequeo(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "P2004"
  );
}

// SP-2 — 0 updated rows means the version moved (or the row vanished); the message
// carries the server's current version so the admin can retry with fresh state.
async function errorConflictoVersion(
  tx: Prisma.TransactionClient,
  tabla: "familia" | "familiaUsuario" | "limiteCredito",
  id: string,
  versionEnviada: number,
): Promise<TRPCError> {
  const actual = await (tabla === "familia"
    ? tx.familia.findUnique({ where: { id }, select: { version: true } })
    : tabla === "familiaUsuario"
      ? tx.familiaUsuario.findUnique({ where: { id }, select: { version: true } })
      : tx.limiteCredito.findUnique({ where: { id }, select: { version: true } }));
  return new TRPCError({
    code: "CONFLICT",
    message: actual
      ? `Conflicto de versión: el registro cambió en el servidor (versión actual: ${actual.version}, enviada: ${versionEnviada})`
      : `Conflicto de versión: el registro no existe en el servidor (versión enviada: ${versionEnviada})`,
  });
}

async function usuarioPorAcceso(
  tx: Prisma.TransactionClient,
  datos: { jefeEmail?: string; jefeUsuarioId?: string },
): Promise<FilaUsuario> {
  const usuario = await tx.usuario.findFirst({
    where: datos.jefeUsuarioId ? { id: datos.jefeUsuarioId } : { correo: datos.jefeEmail },
  });
  if (!usuario?.estado) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "El usuario indicado no existe o está inactivo",
    });
  }
  return usuario;
}

// Idempotent family conversation: one ACTIVE row per familia (partial unique). Reuses an
// inactive row (reactivates) or inserts with ON CONFLICT DO NOTHING + re-read under races.
async function asegurarConversacionFamiliar(
  tx: Prisma.TransactionClient,
  fkFamilia: string,
): Promise<{ id: string; estado: boolean; version: number }> {
  const existente = await tx.conversacion.findFirst({
    where: { fkFamilia },
    orderBy: { creadoEn: "desc" },
  });
  if (existente) {
    if (existente.estado) return existente;
    await tx.conversacion.updateMany({
      where: { id: existente.id, estado: false },
      data: { estado: true, version: { increment: 1 } },
    });
    return { id: existente.id, estado: true, version: existente.version + 1 };
  }
  await tx.$executeRaw`
    INSERT INTO "conversacion" ("fk_familia", "tipo")
    VALUES (${fkFamilia}::uuid, true)
    ON CONFLICT ("fk_familia") WHERE "estado" = true AND "fk_familia" IS NOT NULL DO NOTHING`;
  const activa = await tx.conversacion.findFirstOrThrow({ where: { fkFamilia, estado: true } });
  return { id: activa.id, estado: activa.estado, version: activa.version };
}

// Re-insert (idempotent) the conversation membership: integrantes has a plain UNIQUE pair.
async function asegurarIntegrante(
  tx: Prisma.TransactionClient,
  fkConversacion: string,
  fkUsuario: string,
): Promise<void> {
  await tx.integrante.upsert({
    where: { fkUsuario_fkConversacion: { fkUsuario, fkConversacion } },
    create: { fkUsuario, fkConversacion, rol: "miembro" },
    update: {},
  });
}

async function familiaActiva(
  tx: Prisma.TransactionClient,
  familiaId: string,
): Promise<FilaFamilia> {
  const familia = await tx.familia.findUnique({ where: { id: familiaId } });
  if (!familia) {
    throw new TRPCError({ code: "NOT_FOUND", message: "La familia indicada no existe" });
  }
  if (!familia.estado) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "La familia está inactiva; restáurala primero",
    });
  }
  return familia;
}

// ---- list loader (single source for the admin page DTO) ----

async function cargarFamilias(db: Database, ids: string[]): Promise<Map<string, FamiliaDto>> {
  if (ids.length === 0) return new Map();
  const [familias, membresias, limites] = await Promise.all([
    db.familia.findMany({ where: { id: { in: ids } }, orderBy: { nombre: "asc" } }),
    db.familiaUsuario.findMany({
      where: { fkFamilia: { in: ids } },
      include: { usuario: { select: { correo: true } } },
      orderBy: { creadoEn: "asc" },
    }),
    db.limiteCredito.findMany({ where: { fkFamilia: { in: ids } } }),
  ]);
  const miembrosPorFamilia = new Map<string, MiembroDto[]>();
  for (const m of membresias) {
    const lista = miembrosPorFamilia.get(m.fkFamilia) ?? [];
    lista.push({
      membresiaId: m.id,
      usuarioId: m.fkUsuario,
      correo: m.usuario.correo,
      esJefe: false, // set below from the familia row
      estado: m.estado,
      version: m.version,
    });
    miembrosPorFamilia.set(m.fkFamilia, lista);
  }
  const limitePorFamilia = new Map<string, FilaLimite>();
  for (const l of limites) {
    if (l.fkFamilia) limitePorFamilia.set(l.fkFamilia, l);
  }
  const dtos = new Map<string, FamiliaDto>();
  for (const familia of familias) {
    const miembros = miembrosPorFamilia.get(familia.id) ?? [];
    for (const m of miembros) m.esJefe = m.usuarioId === familia.fkJefeUsuario;
    const limite = limitePorFamilia.get(familia.id) ?? null;
    dtos.set(familia.id, {
      id: familia.id,
      nombre: familia.nombre,
      fkJefeUsuario: familia.fkJefeUsuario,
      estado: familia.estado,
      version: familia.version,
      limite: limite
        ? {
            id: limite.id,
            monto: limite.monto.toFixed(2),
            estado: limite.estado,
            version: limite.version,
          }
        : null,
      miembros,
    });
  }
  return dtos;
}

function aDtoMembresia(fila: FilaMembresia): MembresiaDto {
  return {
    id: fila.id,
    fkUsuario: fila.fkUsuario,
    fkFamilia: fila.fkFamilia,
    estado: fila.estado,
    version: fila.version,
  };
}

function aDtoLimite(fila: FilaLimite): LimiteRespuestaDto {
  return {
    id: fila.id,
    monto: fila.monto.toFixed(2),
    fkFamilia: fila.fkFamilia,
    fkUsuario: fila.fkUsuario,
    estado: fila.estado,
    version: fila.version,
  };
}

// ---- procedures ----

export const familiasRouter = router({
  // Authenticated, scoped: admin → all; others → their own active family only.
  list: protectedProcedure
    .input(z.object({ incluirInactivas: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const esAdmin = ctx.user.rol === ROLE.ADMIN;
      let ids: string[];
      if (esAdmin) {
        const filas = await ctx.db.familia.findMany({
          where: input.incluirInactivas ? undefined : { estado: true },
          select: { id: true },
          orderBy: { nombre: "asc" },
        });
        ids = filas.map((f) => f.id);
      } else {
        const propias = await ctx.db.familiaUsuario.findMany({
          where: { fkUsuario: ctx.user.id, estado: true },
          select: { fkFamilia: true },
        });
        ids = propias.map((m) => m.fkFamilia);
      }
      const mapa = await cargarFamilias(ctx.db, ids);
      return ids.map((id) => mapa.get(id)!).filter(Boolean);
    }),

  // tx: familia + jefe membership + optional limite(familia) + conversación grupal +
  // integrantes(jefe) + outbox rows. Jefe must exist, be active, and have no active
  // membership elsewhere (pre-check + partial unique guarantee).
  create: protectedProcedure
    .input(
      z
        .object({
          nombre: NOMBRE,
          jefeEmail: CORREO.optional(),
          jefeUsuarioId: ID.optional(),
          montoLimite: MONTO.optional(),
        })
        .superRefine((datos, ctxZod) => {
          if (!!datos.jefeEmail === !!datos.jefeUsuarioId) {
            ctxZod.addIssue({
              code: "custom",
              message: "Indique exactamente un jefe: jefeEmail o jefeUsuarioId",
            });
          }
        }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const nombre = input.nombre.trim();
      if (!nombre) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "El nombre es obligatorio" });
      }
      try {
        const familiaId = await ctx.db.$transaction(async (tx) => {
          const jefe = await usuarioPorAcceso(tx, input);
          const activaOtra = await tx.familiaUsuario.findFirst({
            where: { fkUsuario: jefe.id, estado: true },
            select: { id: true },
          });
          if (activaOtra) throw errorMembresiaActiva();

          const familia = await tx.familia.create({
            data: { nombre, fkJefeUsuario: jefe.id },
          });
          const membresia = await tx.familiaUsuario.create({
            data: { fkUsuario: jefe.id, fkFamilia: familia.id },
          });
          const cambios: Array<{
            tablaOrigen: string;
            idFila: string;
            operacion: OperacionOutbox;
          }> = [
            { tablaOrigen: "familia", idFila: familia.id, operacion: "insert" },
            { tablaOrigen: "familia_usuario", idFila: membresia.id, operacion: "insert" },
          ];
          if (input.montoLimite !== undefined) {
            const limite = await tx.limiteCredito.create({
              data: { monto: input.montoLimite, fkFamilia: familia.id },
            });
            cambios.push({
              tablaOrigen: "limite_credito",
              idFila: limite.id,
              operacion: "insert",
            });
          }
          const conversacion = await asegurarConversacionFamiliar(tx, familia.id);
          cambios.push({
            tablaOrigen: "conversacion",
            idFila: conversacion.id,
            operacion: "insert",
          });
          // integrantes is not a synced collection (chat is P1): no outbox row.
          await asegurarIntegrante(tx, conversacion.id, jefe.id);
          await escribirCambios(tx, ctx.user.id, cambios);
          return familia.id;
        });
        const mapa = await cargarFamilias(ctx.db, [familiaId]);
        return mapa.get(familiaId)!;
      } catch (error) {
        if (esViolacionMembresiaActiva(error)) throw errorMembresiaActiva();
        throw error;
      }
    }),

  // Membership with one-active enforcement (server check + DB partial unique). A previous
  // inactive membership of the SAME user+family is reactivated instead of inserted.
  addMember: protectedProcedure
    .input(z.object({ familiaId: ID, email: CORREO }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const correo = input.email.trim().toLowerCase();
      try {
        const membresia = await ctx.db.$transaction(async (tx) => {
          const familia = await familiaActiva(tx, input.familiaId);
          const usuario = await tx.usuario.findUnique({ where: { correo } });
          if (!usuario?.estado) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "El usuario indicado no existe o está inactivo",
            });
          }
          // Clean pre-check (the DB partial unique stays the concurrency guarantee).
          const activaOtra = await tx.familiaUsuario.findFirst({
            where: { fkUsuario: usuario.id, estado: true },
            select: { id: true },
          });
          if (activaOtra) throw errorMembresiaActiva();

          const previa = await tx.familiaUsuario.findFirst({
            where: { fkUsuario: usuario.id, fkFamilia: familia.id },
          });
          let fila: FilaMembresia;
          let operacion: OperacionOutbox;
          if (previa) {
            const reactivadas = await tx.familiaUsuario.updateMany({
              where: { id: previa.id, estado: false },
              data: { estado: true, version: { increment: 1 } },
            });
            if (reactivadas.count === 0) throw errorMembresiaActiva();
            fila = await tx.familiaUsuario.findUniqueOrThrow({ where: { id: previa.id } });
            operacion = "update";
          } else {
            fila = await tx.familiaUsuario.create({
              data: { fkUsuario: usuario.id, fkFamilia: familia.id },
            });
            operacion = "insert";
          }
          const conversacion = await asegurarConversacionFamiliar(tx, familia.id);
          await asegurarIntegrante(tx, conversacion.id, usuario.id);
          await escribirCambios(tx, ctx.user.id, [
            { tablaOrigen: "familia_usuario", idFila: fila.id, operacion },
          ]);
          return fila;
        });
        return aDtoMembresia(membresia);
      } catch (error) {
        if (esViolacionMembresiaActiva(error)) throw errorMembresiaActiva();
        throw error;
      }
    }),

  // Baja lógica. Jefe guard: reassign with setJefe first. The family-conversation
  // integrantes row is DELETED (reversible by re-insert on restore).
  removeMember: protectedProcedure
    .input(z.object({ membresiaId: ID, version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      return ctx.db.$transaction(async (tx) => {
        const previa = await tx.familiaUsuario.findUnique({
          where: { id: input.membresiaId },
        });
        if (!previa) {
          throw new TRPCError({ code: "NOT_FOUND", message: "La membresía no existe" });
        }
        if (previa.estado) {
          const familia = await tx.familia.findUniqueOrThrow({
            where: { id: previa.fkFamilia },
          });
          if (familia.fkJefeUsuario === previa.fkUsuario) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "No se puede dar de baja al jefe de la familia; reasigna el puesto primero",
            });
          }
        }
        const aplicadas = await tx.familiaUsuario.updateMany({
          where: { id: input.membresiaId, version: input.version },
          data: { estado: false, version: { increment: 1 } },
        });
        if (aplicadas.count === 0) {
          throw await errorConflictoVersion(tx, "familiaUsuario", input.membresiaId, input.version);
        }
        const conversacion = await tx.conversacion.findFirst({
          where: { fkFamilia: previa.fkFamilia, estado: true },
          select: { id: true },
        });
        if (conversacion) {
          await tx.integrante.deleteMany({
            where: { fkConversacion: conversacion.id, fkUsuario: previa.fkUsuario },
          });
        }
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "familia_usuario", idFila: input.membresiaId, operacion: "update" },
        ]);
        return { ok: true };
      });
    }),

  // Reactivate a membership; respects one-active (409 if the user joined another family).
  restoreMember: protectedProcedure
    .input(z.object({ membresiaId: ID, version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      try {
        const membresia = await ctx.db.$transaction(async (tx) => {
          const previa = await tx.familiaUsuario.findUnique({
            where: { id: input.membresiaId },
          });
          if (!previa) {
            throw new TRPCError({ code: "NOT_FOUND", message: "La membresía no existe" });
          }
          const familia = await familiaActiva(tx, previa.fkFamilia);
          const aplicadas = await tx.familiaUsuario.updateMany({
            where: { id: input.membresiaId, version: input.version, estado: false },
            data: { estado: true, version: { increment: 1 } },
          });
          if (aplicadas.count === 0) {
            throw await errorConflictoVersion(
              tx,
              "familiaUsuario",
              input.membresiaId,
              input.version,
            );
          }
          // Clean pre-check AFTER the CAS: the user must not hold another active family.
          const activaOtra = await tx.familiaUsuario.findFirst({
            where: { fkUsuario: previa.fkUsuario, estado: true, fkFamilia: { not: familia.id } },
            select: { id: true },
          });
          if (activaOtra) throw errorMembresiaActiva();
          const conversacion = await asegurarConversacionFamiliar(tx, familia.id);
          await asegurarIntegrante(tx, conversacion.id, previa.fkUsuario);
          await escribirCambios(tx, ctx.user.id, [
            { tablaOrigen: "familia_usuario", idFila: input.membresiaId, operacion: "update" },
          ]);
          return tx.familiaUsuario.findUniqueOrThrow({ where: { id: input.membresiaId } });
        });
        return aDtoMembresia(membresia);
      } catch (error) {
        if (esViolacionMembresiaActiva(error)) throw errorMembresiaActiva();
        throw error;
      }
    }),

  // Reassign the family jefe; the target must be an active member.
  setJefe: protectedProcedure
    .input(z.object({ familiaId: ID, usuarioId: ID, version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      return ctx.db.$transaction(async (tx) => {
        const familia = await familiaActiva(tx, input.familiaId);
        const membresia = await tx.familiaUsuario.findFirst({
          where: { fkFamilia: familia.id, fkUsuario: input.usuarioId, estado: true },
          select: { id: true },
        });
        if (!membresia) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "El usuario no es un miembro activo de la familia",
          });
        }
        const aplicadas = await tx.familia.updateMany({
          where: { id: familia.id, version: input.version },
          data: { fkJefeUsuario: input.usuarioId, version: { increment: 1 } },
        });
        if (aplicadas.count === 0) {
          throw await errorConflictoVersion(tx, "familia", familia.id, input.version);
        }
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "familia", idFila: familia.id, operacion: "update" },
        ]);
        return { ok: true };
      });
    }),

  // Admin upsert by owner (familia XOR usuario): creates when absent, CAS-updates when
  // present (version required then), and reactivates an existing row (any estado).
  setLimite: protectedProcedure
    .input(
      z
        .object({
          familiaId: ID.optional(),
          usuarioId: ID.optional(),
          monto: MONTO,
          version: VERSION.optional(),
        })
        .superRefine((datos, ctxZod) => {
          if (!!datos.familiaId === !!datos.usuarioId) {
            ctxZod.addIssue({
              code: "custom",
              message: "Indique exactamente un propietario: familiaId o usuarioId",
            });
          }
        }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      try {
        return await ctx.db.$transaction(async (tx) => {
          if (input.familiaId) await familiaActiva(tx, input.familiaId);
          if (input.usuarioId) {
            const usuario = await tx.usuario.findUnique({ where: { id: input.usuarioId } });
            if (!usuario?.estado) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "El usuario indicado no existe o está inactivo",
              });
            }
          }
          const existente = await tx.limiteCredito.findFirst({
            where: input.familiaId
              ? { fkFamilia: input.familiaId }
              : { fkUsuario: input.usuarioId },
          });
          if (existente) {
            if (input.version === undefined) {
              throw new TRPCError({
                code: "CONFLICT",
                message:
                  "Conflicto de versión: el límite ya existe; envíe su versión para actualizarlo",
              });
            }
            const aplicadas = await tx.limiteCredito.updateMany({
              where: { id: existente.id, version: input.version },
              data: { monto: input.monto, estado: true, version: { increment: 1 } },
            });
            if (aplicadas.count === 0) {
              throw await errorConflictoVersion(tx, "limiteCredito", existente.id, input.version);
            }
            await escribirCambios(tx, ctx.user.id, [
              { tablaOrigen: "limite_credito", idFila: existente.id, operacion: "update" },
            ]);
            return aDtoLimite(
              await tx.limiteCredito.findUniqueOrThrow({ where: { id: existente.id } }),
            );
          }
          const limite = await tx.limiteCredito.create({
            data: {
              monto: input.monto,
              ...(input.familiaId
                ? { fkFamilia: input.familiaId }
                : { fkUsuario: input.usuarioId }),
            },
          });
          await escribirCambios(tx, ctx.user.id, [
            { tablaOrigen: "limite_credito", idFila: limite.id, operacion: "insert" },
          ]);
          return aDtoLimite(limite);
        });
      } catch (error) {
        if (esViolacionChequeo(error)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Los datos violan una restricción de integridad (monto >= 0, propietario único)",
          });
        }
        throw error;
      }
    }),

  // Family soft-delete / restore with cascade:
  // - estado=false: memberships + conversation deactivated; integrantes deleted.
  // - estado=true: memberships restored EXCEPT users who joined another family meanwhile
  //   (reported as omitidos); conversation reactivated.
  setEstado: protectedProcedure
    .input(z.object({ familiaId: ID, version: VERSION, estado: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      return ctx.db.$transaction(async (tx) => {
        const familia = await tx.familia.findUnique({ where: { id: input.familiaId } });
        if (!familia) {
          throw new TRPCError({ code: "NOT_FOUND", message: "La familia indicada no existe" });
        }
        const aplicadas = await tx.familia.updateMany({
          where: { id: familia.id, version: input.version },
          data: { estado: input.estado, version: { increment: 1 } },
        });
        if (aplicadas.count === 0) {
          throw await errorConflictoVersion(tx, "familia", familia.id, input.version);
        }
        const cambios: Array<{
          tablaOrigen: string;
          idFila: string;
          operacion: OperacionOutbox;
        }> = [{ tablaOrigen: "familia", idFila: familia.id, operacion: "update" }];

        if (!input.estado) {
          const activas = await tx.familiaUsuario.findMany({
            where: { fkFamilia: familia.id, estado: true },
            select: { id: true },
          });
          await tx.familiaUsuario.updateMany({
            where: { fkFamilia: familia.id, estado: true },
            data: { estado: false, version: { increment: 1 } },
          });
          for (const m of activas) {
            cambios.push({ tablaOrigen: "familia_usuario", idFila: m.id, operacion: "update" });
          }
          const conversacion = await tx.conversacion.findFirst({
            where: { fkFamilia: familia.id, estado: true },
            select: { id: true },
          });
          if (conversacion) {
            await tx.conversacion.updateMany({
              where: { id: conversacion.id, estado: true },
              data: { estado: false, version: { increment: 1 } },
            });
            await tx.integrante.deleteMany({ where: { fkConversacion: conversacion.id } });
            cambios.push({
              tablaOrigen: "conversacion",
              idFila: conversacion.id,
              operacion: "update",
            });
          }
          await escribirCambios(tx, ctx.user.id, cambios);
          return { ok: true, omitidos: [] as string[] };
        }

        // Restore: reactivate the conversation first (idempotent), then the memberships
        // that do not violate one-active.
        const conversacion = await asegurarConversacionFamiliar(tx, familia.id);
        cambios.push({
          tablaOrigen: "conversacion",
          idFila: conversacion.id,
          operacion: "update",
        });
        const inactivas = await tx.familiaUsuario.findMany({
          where: { fkFamilia: familia.id, estado: false },
          orderBy: { creadoEn: "asc" },
        });
        const idsUsuarios = [...new Set(inactivas.map((m) => m.fkUsuario))];
        const otrasActivas = idsUsuarios.length
          ? await tx.familiaUsuario.findMany({
              where: {
                fkUsuario: { in: idsUsuarios },
                estado: true,
                fkFamilia: { not: familia.id },
              },
              select: { fkUsuario: true },
            })
          : [];
        const enOtraFamilia = new Set(otrasActivas.map((m) => m.fkUsuario));
        const omitidos: string[] = [];
        for (const membresia of inactivas) {
          if (enOtraFamilia.has(membresia.fkUsuario)) {
            omitidos.push(membresia.fkUsuario);
            continue;
          }
          const restaurada = await tx.familiaUsuario.updateMany({
            where: { id: membresia.id, estado: false },
            data: { estado: true, version: { increment: 1 } },
          });
          if (restaurada.count === 0) continue; // raced with another restore; skip
          await asegurarIntegrante(tx, conversacion.id, membresia.fkUsuario);
          cambios.push({
            tablaOrigen: "familia_usuario",
            idFila: membresia.id,
            operacion: "update",
          });
        }
        await escribirCambios(tx, ctx.user.id, cambios);
        const correos = omitidos.length
          ? await tx.usuario.findMany({
              where: { id: { in: omitidos } },
              select: { correo: true },
            })
          : [];
        return { ok: true, omitidos: correos.map((u) => u.correo) };
      });
    }),
});
