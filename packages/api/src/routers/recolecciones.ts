import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  ESTADO_RECOLECCION,
  hoyNegocio,
  parseFechaCiclo,
  aFechaCiclo,
  transicionRecoleccion,
} from "@rassa-jala/db";
import { ROLE, type Role } from "../context";
import type { Database, Prisma, EstadoRecoleccion } from "@rassa-jala/db";

import { protectedProcedure, router } from "../index";

// P0 Recolecciones — the seller's harvest-collection agenda (docs/roadmap.md §5 P0-B;
// docs/database.md §3.5 rows + M-14, §4.2 R1 partial unique, M-4 domain CHECK;
// docs/scope.md §3.1 Recolecciones row). Business rules extracted from the legacy
// blueprint (recoleccion/{views,serializers,constants}.py) — never copied:
//
// - R1: ONE active slot per (fk_agricultor, fecha_recoleccion). The DB-level partial
//   unique (excluding 'cancelado') is the final guarantee; the pre-check under the
//   advisory lock gives a clean 400 with the legacy message instead of a raw P2002.
// - The server adjudicates EVERYTHING (database.md §6.2 "Escritura offline: No" +
//   synchronization.md §9 "Confirmación online"): creation/advances/cancel are
//   online-confirm mutations with operationId idempotency (sync doc §7). No push lane,
//   no RxDB collection (COL23 — the web already opens 13 collections; M-14 documents
//   the decision).
// - Roles (legacy HasRole parity): Admin/Vendedor operate (create/advance/cancel) on
//   the shared agenda; Agricultor reads ONLY its own; Cliente has no access (403).
// - NO money, stock or credit: a recoleccion carries none (docs verify — R1-R7 are
//   slot/booking rules), so money.ts does not apply here.

const ID = z.uuid();
const VERSION = z.number().int().positive();
const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// 'HH:MM' or 'HH:MM:SS' — business-local wall clock of the appointment window (Q-22).
const HORA = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/);
const COMENTARIOS = z.string().max(1000);

// ---- DTO (dates/times as ISO strings — database.md §6.3) ----

interface RecoleccionDto {
  id: string;
  fkAgricultor: string;
  agricultorNombre: string | null;
  // T22 (PDF M5.7): the farmer's location (persona→localidad→municipio) so the
  // agenda groups/route-plans by place. Nullable — persona.fk_localidad is SetNull.
  localidad: string | null;
  municipio: string | null;
  fechaRecoleccion: string;
  horaInicio: string | null;
  horaFin: string | null;
  estado: string;
  comentarios: string | null;
  version: number;
  actualizadoEn: string;
  creadoEn: string;
}

interface HistorialDto {
  id: string;
  estadoAnterior: string | null;
  estadoNuevo: string;
  actor: string | null;
  creadoEn: string;
}

// @db.Time materializes as a Date anchored at 1970-01-01 — wall-clock extract.
function horaIso(hora: Date | null): string | null {
  return hora ? hora.toISOString().slice(11, 19) : null;
}

/** 'HH:MM[:SS]' → Time-anchored Date for the @db.Time column. */
function parseHora(hora: string): Date {
  const [hh, mm, ss] = hora.split(":");
  return new Date(Date.UTC(1970, 0, 1, Number(hh), Number(mm), Number(ss ?? 0)));
}

function aDto(
  fila: Prisma.RecoleccionGetPayload<{
    include: {
      agricultor: {
        include: { persona: { include: { localidad: { include: { municipio: true } } } } };
      };
    };
  }>,
): RecoleccionDto {
  const persona = fila.agricultor.persona;
  return {
    id: fila.id,
    fkAgricultor: fila.fkAgricultor,
    agricultorNombre: persona ? `${persona.nombre} ${persona.apellidoPaterno}`.trim() : null,
    localidad: persona?.localidad?.nombre ?? null,
    municipio: persona?.localidad?.municipio?.nombre ?? null,
    fechaRecoleccion: aFechaCiclo(fila.fechaRecoleccion),
    horaInicio: horaIso(fila.horaInicio),
    horaFin: horaIso(fila.horaFin),
    estado: fila.estado,
    comentarios: fila.comentarios,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    creadoEn: fila.creadoEn.toISOString(),
  };
}

function aDtoHistorial(fila: {
  id: string;
  estadoAnterior: string | null;
  estadoNuevo: string;
  fkCambiadoPor: string | null;
  creadoEn: Date;
}): HistorialDto {
  return {
    id: fila.id,
    estadoAnterior: fila.estadoAnterior,
    estadoNuevo: fila.estadoNuevo,
    actor: fila.fkCambiadoPor,
    creadoEn: fila.creadoEn.toISOString(),
  };
}

// ---- shared helpers ----

type OperacionOutbox = "insert" | "update";

/** M-1a: outbox rows ride in the SAME transaction as the row writes. */
async function escribirCambios(
  tx: Prisma.TransactionClient,
  actor: string,
  cambios: Array<{ tablaOrigen: string; idFila: string; operacion: OperacionOutbox }>,
): Promise<void> {
  if (cambios.length === 0) return;
  await tx.syncCambio.createMany({ data: cambios.map((c) => ({ ...c, actor })) });
}

function asegurarRol(rol: Role, permitidos: Role[], mensaje: string): void {
  if (!permitidos.includes(rol)) {
    throw new TRPCError({ code: "FORBIDDEN", message: mensaje });
  }
}

const OPERADORES: Role[] = [ROLE.ADMIN, ROLE.VENDEDOR];
const MSG_SOLO_OPERADORES = "Solo Vendedor o Admin pueden operar la agenda de recolecciones";

// ---- THE single creation adjudication entry point ----

/**
 * Domain rejection sentinel: thrown INSIDE the creation transaction so every effect
 * rolls back; the caller maps it to the lane's failure shape (tRPC 400 / replay).
 */
export class RechazoRecoleccion extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "RechazoRecoleccion";
  }
}

type EntradaCreacionRecoleccion = {
  fkAgricultor: string;
  fechaRecoleccion: string; // 'YYYY-MM-DD'
  horaInicio: string | null;
  horaFin: string | null;
  comentarios: string | null;
  actor: string; // authenticated Usuario (outbox + historial actor)
  operationId?: string;
};

const MSG_DUPLICADO = "El agricultor ya tiene una recolección programada para esta fecha.";
const MSG_AGRICULTOR_INVALIDO = "El agricultor especificado no existe o está inactivo.";
const MSG_AGRICULTOR_SIN_ROL = "El agricultor especificado no tiene rol Agricultor.";
const MSG_FECHA_PASADA = "La fecha no puede ser anterior a hoy.";
const MSG_HORAS_PAR = "Deben indicarse ambas horas (inicio y fin) o ninguna.";
const MSG_HORAS_ORDEN = "hora_fin debe ser posterior a hora_inicio.";

/**
 * R1 central adjudication — used by `crear` (online). Inside ONE tx:
 *  a. advisory lock `recolecciones_slot` — serializes the (agricultor, fecha) decision
 *     across concurrent creators (legacy locked the agricultor row; the v2 advisory-lock
 *     primitive is the registered pattern, roadmap §8);
 *  b. the agricultor must exist, be ACTIVE and hold the Agricultor role (fresh from DB);
 *  c. horas both-or-none + hora_fin > hora_inicio (legacy serializer parity);
 *  d. the appointment date cannot be in the past (business today, America/Mazatlan, Q-22);
 *  e. R1 pre-check: no other row for (agricultor, fecha) with estado != 'cancelado' —
 *     the DB partial unique is the last word (P2002 maps to the same motivo);
 *  f. insert recoleccion (estado 'pendiente') + historial row (anterior = null) +
 *     outbox rows — one tx.
 *
 * Throws RechazoRecoleccion(motivo) on domain failure.
 */
export async function adjudicarRecoleccion(
  tx: Prisma.TransactionClient,
  entrada: EntradaCreacionRecoleccion,
): Promise<RecoleccionDto> {
  // a. Serialize the slot decision.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('recolecciones_slot'))`;

  // b. Agricultor: fresh active + role from DB (legacy _lockear_y_validar_agricultor).
  const agricultor = await tx.usuario.findUnique({
    where: { id: entrada.fkAgricultor },
    select: { estado: true, rol: { select: { nombre: true } } },
  });
  if (!agricultor?.estado) throw new RechazoRecoleccion(MSG_AGRICULTOR_INVALIDO);
  if (agricultor.rol.nombre !== ROLE.AGRICULTOR)
    throw new RechazoRecoleccion(MSG_AGRICULTOR_SIN_ROL);

  // c. Hours pair (legacy both-or-none by VALUE presence + fin > inicio).
  if ((entrada.horaInicio !== null) !== (entrada.horaFin !== null)) {
    throw new RechazoRecoleccion(MSG_HORAS_PAR);
  }
  if (entrada.horaInicio && entrada.horaFin) {
    const inicio = parseHora(entrada.horaInicio).getTime();
    const fin = parseHora(entrada.horaFin).getTime();
    if (fin <= inicio) throw new RechazoRecoleccion(MSG_HORAS_ORDEN);
  }

  // d. Date gate (create only — the legacy PATCH backdating rule is an edit-lane rule).
  const hoy = hoyNegocio(new Date());
  if (entrada.fechaRecoleccion < hoy) throw new RechazoRecoleccion(MSG_FECHA_PASADA);

  // e. R1 pre-check under the lock (the partial unique is the final guarantee).
  const duplicada = await tx.recoleccion.findFirst({
    where: {
      fkAgricultor: entrada.fkAgricultor,
      fechaRecoleccion: parseFechaCiclo(entrada.fechaRecoleccion),
      estado: { not: ESTADO_RECOLECCION.CANCELADO },
    },
    select: { id: true },
  });
  if (duplicada) throw new RechazoRecoleccion(MSG_DUPLICADO);

  // f. Row + historial + outbox — ONE tx.
  let creada;
  try {
    creada = await tx.recoleccion.create({
      data: {
        fkAgricultor: entrada.fkAgricultor,
        fechaRecoleccion: parseFechaCiclo(entrada.fechaRecoleccion),
        ...(entrada.horaInicio ? { horaInicio: parseHora(entrada.horaInicio) } : {}),
        ...(entrada.horaFin ? { horaFin: parseHora(entrada.horaFin) } : {}),
        estado: ESTADO_RECOLECCION.PENDIENTE,
        comentarios: entrada.comentarios,
      },
      include: {
        agricultor: {
          include: { persona: { include: { localidad: { include: { municipio: true } } } } },
        },
      },
    });
  } catch (error) {
    // A creator that raced past every check still hits the partial unique.
    if ((error as { code?: string }).code === "P2002") {
      throw new RechazoRecoleccion(MSG_DUPLICADO);
    }
    throw error;
  }
  const historial = await tx.historialEstadoRecoleccion.create({
    data: {
      fkRecoleccion: creada.id,
      estadoAnterior: null,
      estadoNuevo: ESTADO_RECOLECCION.PENDIENTE,
      fkCambiadoPor: entrada.actor,
    },
  });
  await escribirCambios(tx, entrada.actor, [
    { tablaOrigen: "recoleccion", idFila: creada.id, operacion: "insert" },
    { tablaOrigen: "historial_estado_recoleccion", idFila: historial.id, operacion: "insert" },
  ]);
  return aDto(creada);
}

/** Online-lane runner with operationId idempotency (sync doc §7 — pedidos parity). */
async function ejecutarCreacion(
  db: Database,
  entrada: EntradaCreacionRecoleccion,
): Promise<RecoleccionDto> {
  const { operationId, ...cuerpo } = entrada;
  try {
    return await db.$transaction(async (tx) => {
      if (operationId) {
        const previa = await tx.syncOperacion.findUnique({ where: { id: operationId } });
        if (previa) {
          const respuesta = (previa.respuesta ?? {}) as {
            recoleccion?: RecoleccionDto;
            motivo?: string;
          };
          if (previa.veredicto === "aplicada" && respuesta.recoleccion)
            return respuesta.recoleccion;
          throw new RechazoRecoleccion(
            respuesta.motivo ?? "La operación fue rechazada previamente",
          );
        }
      }
      const creada = await adjudicarRecoleccion(tx, cuerpo);
      if (operationId) {
        await tx.syncOperacion.create({
          data: {
            id: operationId,
            fkUsuario: entrada.actor,
            coleccion: "recolecciones",
            docId: creada.id,
            op: "create",
            veredicto: "aplicada",
            respuesta: { recoleccion: creada } as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return creada;
    });
  } catch (error) {
    if (error instanceof RechazoRecoleccion) {
      if (operationId) {
        await db.syncOperacion
          .create({
            data: {
              id: operationId,
              fkUsuario: entrada.actor,
              coleccion: "recolecciones",
              docId: crypto.randomUUID(),
              op: "create",
              veredicto: "rechazada",
              respuesta: { motivo: error.message } as unknown as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined); // a concurrent replay already stored the verdict
      }
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    throw error;
  }
}

// ---- procedures ----

// T22: persona's localidad + municipio ride along for the agenda's location
// grouping (route planning) — one include, no extra query.
const inclAgricultor = {
  agricultor: {
    include: { persona: { include: { localidad: { include: { municipio: true } } } } },
  },
} as const;

/** Legacy `/agricultores` selector: active users holding the Agricultor role. */
export const recoleccionesRouter = router({
  agricultores: protectedProcedure.query(async ({ ctx }) => {
    asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
    const filas = await ctx.db.usuario.findMany({
      where: { estado: true, rol: { nombre: ROLE.AGRICULTOR } },
      select: {
        id: true,
        persona: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } },
      },
      orderBy: [{ persona: { nombre: "asc" } }],
    });
    return filas.map((f) => ({
      id: f.id,
      nombre: f.persona.nombre,
      apellidoPaterno: f.persona.apellidoPaterno,
      apellidoMaterno: f.persona.apellidoMaterno,
    }));
  }),

  // Agenda listing (legacy list parity): Admin/Vendedor see the full agenda; the
  // Agricultor sees ONLY its own (a foreign fkAgricultor filter is 403, legacy
  // MSG_AGRICULTOR_SOLO_PROPIAS); Cliente has no read access (403).
  listar: protectedProcedure
    .input(
      z
        .object({
          fkAgricultor: ID.optional(),
          fecha: FECHA.optional(),
          desde: FECHA.optional(),
          hasta: FECHA.optional(),
          estado: z.string().max(20).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const rol = ctx.user.rol;
      if (rol === ROLE.CLIENTE) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Un cliente no consulta recolecciones",
        });
      }
      if (rol === ROLE.AGRICULTOR) {
        if (input?.fkAgricultor && input.fkAgricultor !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Un agricultor solo puede consultar sus propias recolecciones.",
          });
        }
        return ctx.db.recoleccion
          .findMany({
            where: { fkAgricultor: ctx.user.id },
            include: inclAgricultor,
            orderBy: [{ fechaRecoleccion: "asc" }, { horaInicio: "asc" }],
          })
          .then((filas) => filas.map(aDto));
      }
      const filtros: Prisma.RecoleccionWhereInput = {
        ...(input?.fkAgricultor ? { fkAgricultor: input.fkAgricultor } : {}),
        ...(input?.fecha ? { fechaRecoleccion: parseFechaCiclo(input.fecha) } : {}),
        ...(input?.desde || input?.hasta
          ? {
              fechaRecoleccion: {
                ...(input?.desde ? { gte: parseFechaCiclo(input.desde) } : {}),
                ...(input?.hasta ? { lte: parseFechaCiclo(input.hasta) } : {}),
              },
            }
          : {}),
        ...(input?.estado ? { estado: input.estado } : {}),
      };
      const filas = await ctx.db.recoleccion.findMany({
        where: filtros,
        include: inclAgricultor,
        orderBy: [{ fechaRecoleccion: "asc" }, { horaInicio: "asc" }],
      });
      return filas.map(aDto);
    }),

  // Scoped detail + historial (legacy retrieve parity: the same read scoping).
  detalle: protectedProcedure.input(z.object({ id: ID })).query(async ({ input, ctx }) => {
    const fila = await ctx.db.recoleccion.findUnique({
      where: { id: input.id },
      include: { ...inclAgricultor, historial: true },
    });
    if (!fila) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Recolección no encontrada" });
    }
    if (ctx.user.rol === ROLE.AGRICULTOR && fila.fkAgricultor !== ctx.user.id) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Un agricultor solo puede consultar sus propias recolecciones.",
      });
    }
    if (ctx.user.rol === ROLE.CLIENTE) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Un cliente no consulta recolecciones" });
    }
    return {
      ...aDto(fila),
      historial: fila.historial.map(aDtoHistorial),
    };
  }),

  // Online creation (legacy create parity; Admin/Vendedor). operationId (sync doc §7):
  // a retry with the SAME id returns the stored verdict without re-executing effects.
  crear: protectedProcedure
    .input(
      z.object({
        fkAgricultor: ID,
        fechaRecoleccion: FECHA,
        horaInicio: HORA.optional(),
        horaFin: HORA.optional(),
        comentarios: COMENTARIOS.optional(),
        operationId: ID.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
      return ejecutarCreacion(ctx.db, {
        fkAgricultor: input.fkAgricultor,
        fechaRecoleccion: input.fechaRecoleccion,
        horaInicio: input.horaInicio ?? null,
        horaFin: input.horaFin ?? null,
        comentarios: input.comentarios ?? null,
        actor: ctx.user.id,
        operationId: input.operationId,
      });
    }),

  // Strict state machine (legacy /estado/): same-state and invalid transitions → 400;
  // CAS version → 0 rows → 409. Historial + outbox ride in ONE tx.
  avanzar: protectedProcedure
    .input(z.object({ id: ID, estado: z.string().max(20), version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
      if (!Object.values(ESTADO_RECOLECCION).includes(input.estado as EstadoRecoleccion)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Estado inválido. Valores válidos: pendiente, en_ruta, recolectado, cancelado.`,
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const fila = await tx.recoleccion.findUnique({
          where: { id: input.id },
          include: inclAgricultor,
        });
        if (!fila) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Recolección no encontrada" });
        }
        const veredicto = transicionRecoleccion(
          fila.estado,
          input.estado,
          aFechaCiclo(fila.fechaRecoleccion),
          hoyNegocio(new Date()),
        );
        if (!veredicto.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: veredicto.motivo });
        }
        const aplicadas = await tx.recoleccion.updateMany({
          where: { id: fila.id, version: input.version },
          data: { estado: input.estado, version: { increment: 1 } },
        });
        if (aplicadas.count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "La recolección cambió en el servidor; reintenta con su versión actual",
          });
        }
        const historial = await tx.historialEstadoRecoleccion.create({
          data: {
            fkRecoleccion: fila.id,
            estadoAnterior: fila.estado,
            estadoNuevo: input.estado,
            fkCambiadoPor: ctx.user.id,
          },
        });
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "recoleccion", idFila: fila.id, operacion: "update" },
          {
            tablaOrigen: "historial_estado_recoleccion",
            idFila: historial.id,
            operacion: "insert",
          },
        ]);
        const actualizada = await tx.recoleccion.findUniqueOrThrow({
          where: { id: fila.id },
          include: inclAgricultor,
        });
        return aDto(actualizada);
      });
    }),

  // Idempotent cancel (legacy /cancelar/): already-cancelled → 200 with the legacy
  // message and NO new historial/transition; otherwise the strict transition + CAS.
  cancelar: protectedProcedure
    .input(z.object({ id: ID, version: VERSION }))
    .mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
      return ctx.db.$transaction(async (tx) => {
        const fila = await tx.recoleccion.findUnique({
          where: { id: input.id },
          include: inclAgricultor,
        });
        if (!fila) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Recolección no encontrada" });
        }
        if (fila.estado === ESTADO_RECOLECCION.CANCELADO) {
          return { recoleccion: aDto(fila), mensaje: "La recolección ya estaba cancelada." };
        }
        const veredicto = transicionRecoleccion(
          fila.estado,
          ESTADO_RECOLECCION.CANCELADO,
          aFechaCiclo(fila.fechaRecoleccion),
          hoyNegocio(new Date()),
        );
        if (!veredicto.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: veredicto.motivo });
        }
        const aplicadas = await tx.recoleccion.updateMany({
          where: { id: fila.id, version: input.version },
          data: { estado: ESTADO_RECOLECCION.CANCELADO, version: { increment: 1 } },
        });
        if (aplicadas.count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "La recolección cambió en el servidor; reintenta con su versión actual",
          });
        }
        const historial = await tx.historialEstadoRecoleccion.create({
          data: {
            fkRecoleccion: fila.id,
            estadoAnterior: fila.estado,
            estadoNuevo: ESTADO_RECOLECCION.CANCELADO,
            fkCambiadoPor: ctx.user.id,
          },
        });
        await escribirCambios(tx, ctx.user.id, [
          { tablaOrigen: "recoleccion", idFila: fila.id, operacion: "update" },
          {
            tablaOrigen: "historial_estado_recoleccion",
            idFila: historial.id,
            operacion: "insert",
          },
        ]);
        const actualizada = await tx.recoleccion.findUniqueOrThrow({
          where: { id: fila.id },
          include: inclAgricultor,
        });
        return { recoleccion: aDto(actualizada), mensaje: "Recolección cancelada correctamente." };
      });
    }),
});
