import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Prisma } from "@rassa-jala/db";

import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";

// T11 gap-pass-7 — Bitácora de auditoría (M-7, database.md §3.7; backend-audit §2.6:
// legacy GET /api/logs/ was Admin-only list/retrieve). READ-ONLY module over the
// append-only `logs` table (S4 server-only: never synced, never in an outbox).
//
// - list: Admin-only, paginated (page/pageSize, newest first), filters: usuario,
//   acción, rango de fechas (creado_en calendar date, business-TZ via the caller's
//   ISO date → same predicate family as historiales.resumenMermas) and a free-text
//   search on entidad.
// - acciones: DISTINCT accion values for the filter's select — the vocabulary lives
//   in the DB, not in a hardcoded enum.

const ID = z.uuid();
const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (YYYY-MM-DD)");

function asegurarAdmin(rol: Role): void {
  if (rol !== ROLE.ADMIN) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Solo el rol Admin puede consultar la bitácora",
    });
  }
}

type FilaLog = {
  id: string;
  accion: string;
  entidad: string | null;
  entidadId: string | null;
  ip: string;
  dispositivo: string;
  detalle: unknown;
  creadoEn: string;
  usuario: { id: string; correo: string; nombre: string | null } | null;
};

function aDto(
  fila: Prisma.LogGetPayload<{ include: { usuario: { include: { persona: true } } } }>,
): FilaLog {
  return {
    id: fila.id,
    accion: fila.accion,
    entidad: fila.entidad,
    entidadId: fila.entidadId,
    ip: fila.ip,
    dispositivo: fila.dispositivo,
    detalle: fila.detalle,
    creadoEn: fila.creadoEn.toISOString(),
    usuario: fila.usuario
      ? {
          id: fila.usuario.id,
          correo: fila.usuario.correo,
          nombre: fila.usuario.persona
            ? `${fila.usuario.persona.nombre} ${fila.usuario.persona.apellidoPaterno}`.trim()
            : null,
        }
      : null,
  };
}

export const logsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(200).default(50),
        usuarioId: ID.optional(),
        accion: z.string().min(1).max(100).optional(),
        desde: FECHA.optional(),
        hasta: FECHA.optional(),
        entidad: z.string().min(1).max(100).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      asegurarAdmin(ctx.user.rol);
      const where: Prisma.LogWhereInput = {
        ...(input.usuarioId ? { fkUsuario: input.usuarioId } : {}),
        ...(input.accion ? { accion: input.accion } : {}),
        ...(input.entidad ? { entidad: { contains: input.entidad, mode: "insensitive" } } : {}),
        ...(input.desde || input.hasta
          ? {
              creadoEn: {
                ...(input.desde ? { gte: new Date(`${input.desde}T00:00:00.000Z`) } : {}),
                ...(input.hasta ? { lt: new Date(`${input.hasta}T23:59:59.999Z`) } : {}),
              },
            }
          : {}),
      };
      const [filas, total] = await Promise.all([
        ctx.db.log.findMany({
          where,
          include: { usuario: { include: { persona: true } } },
          orderBy: { creadoEn: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        ctx.db.log.count({ where }),
      ]);
      return { filas: filas.map(aDto), total, page: input.page, pageSize: input.pageSize };
    }),

  acciones: protectedProcedure.query(async ({ ctx }) => {
    asegurarAdmin(ctx.user.rol);
    const filas = await ctx.db.log.findMany({
      distinct: ["accion"],
      select: { accion: true },
      orderBy: { accion: "asc" },
    });
    return filas.map((f) => f.accion);
  }),
});
