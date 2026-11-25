import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  ESTADO_CORTE_CREACION,
  TIPO_PAGO_EFECTIVO,
  aFechaCiclo,
  hoyNegocio,
  limitesDiaNegocio,
  parseFechaCiclo,
} from "@rassa-jala/db";
import type { Database, Prisma } from "@rassa-jala/db";

import { aCentavos, aDecimal, sumaCentavos } from "../money";
import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";
import { ACCION_LOG, registrarLog } from "../lib/registrar-log";

// P1-A Cortes de caja (docs/roadmap.md §6 P1-A; docs/database.md §3.5 row + M-15,
// §4.2 partial unique, §4.6/§4.7 formula validated 3/3; backend-audit C1-C4).
// Business rules extracted from the legacy blueprint (cortes/{views,serializers}.py)
// — never copied:
//
// - C1: monto_teorico = sum of CASH pagos (tipo_pago name 'Efectivo', legacy iexact
//   parity → case-insensitive) of the caller's pedidos within the Mazatlan business
//   day (limitesDiaNegocio — a 23:59 local pago belongs to its local day).
// - C2: ONE corte per (vendedor, fecha) — DB partial unique is the final guarantee;
//   the pre-check under the advisory lock gives the clean legacy 400 message.
// - C3: teorico/diferencia are creation-time snapshots frozen server-side; the client
//   can NEVER send amounts (only monto_real, the counted drawer cash) and later pagos
//   never retro-update them. diferencia = monto_real - monto_teorico (DB CHECK).
// - C4: the legacy /teorico/ endpoint cached 60s for UI reads; v2 skips the cache —
//   the query is a single indexed aggregate and create() always computed fresh.
// - Legacy parity: create is ALWAYS for the authenticated user (Admin cuts its own
//   day; there is no create-for-other lane), sets estado='cerrado' at insert, and
//   there is NO edit lane (list/retrieve/create/teorico only) — snapshots are final.
// - COL23 / sync (database.md §6.2): online-confirm module like recolecciones —
//   server-fetched reads, tRPC mutations with operationId idempotency, NO RxDB
//   collection (the web is at the 13-collection cap). Outbox rows still ride in ONE
//   tx so a future PULL stays deliverable (M-1a).
// - Money: money.ts integer cents end-to-end (aCentavos → exact sum → aDecimal).

const ID = z.uuid();
// Real calendar date ('2027-02-30' must be rejected by zod → clean 400, not a 500
// from a downstream throw). parseFechaCiclo validates the calendar rollover.
const FECHA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((f) => {
    try {
      parseFechaCiclo(f);
      return true;
    } catch {
      return false;
    }
  }, "Fecha inválida");
// Legacy DecimalField(max_digits=10, decimal_places=2, min_value=0.00) — a sign or a
// third decimal would make aCentavos throw; this regex mirrors the exact input shape.
const MONTO = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);

// ---- DTO (money as string, dates ISO 8601 — database.md §6.3) ----

interface CorteDto {
  id: string;
  fkVendedor: string | null;
  vendedorNombre: string | null;
  fecha: string;
  montoTeorico: string;
  montoReal: string;
  diferencia: string;
  estado: string;
  version: number;
  actualizadoEn: string;
  creadoEn: string;
}

type FilaCorte = Prisma.CorteGetPayload<{
  include: { vendedor: { include: { persona: true } } };
}>;

function nombrePersona(persona: { nombre: string; apellidoPaterno: string } | null): string | null {
  return persona ? `${persona.nombre} ${persona.apellidoPaterno}` : null;
}

function aDto(fila: FilaCorte): CorteDto {
  return {
    id: fila.id,
    fkVendedor: fila.fkVendedor,
    vendedorNombre: nombrePersona(fila.vendedor?.persona ?? null),
    fecha: aFechaCiclo(fila.fecha),
    montoTeorico: fila.montoTeorico.toFixed(2),
    montoReal: fila.montoReal.toFixed(2),
    diferencia: fila.diferencia.toFixed(2),
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
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
const MSG_SOLO_OPERADORES = "Solo Vendedor o Admin consultan cortes de caja";

const MSG_DUPLICADO = "Ya existe un corte para la fecha";

/**
 * C1 exact teorico: sum of the vendedor's CASH pagos inside the Mazatlan business
 * day, in integer cents (money.ts). The sum happens in JS over the day's rows (a
 * handful) so every amount is parsed through aCentavos — no DB float aggregation.
 */
async function montoTeoricoDelDia(
  db: Database | Prisma.TransactionClient,
  fkVendedor: string,
  fecha: string,
): Promise<number> {
  const { inicio, fin } = limitesDiaNegocio(fecha);
  const pagos = await db.pago.findMany({
    where: {
      pedido: { fkVendedor },
      tipoPago: { nombre: { equals: TIPO_PAGO_EFECTIVO, mode: "insensitive" } },
      creadoEn: { gte: inicio, lt: fin },
    },
    select: { monto: true },
  });
  return sumaCentavos(pagos.map((p) => aCentavos(p.monto.toFixed(2))));
}

/** The FECHA schema already validated the calendar date (parseFechaCiclo in zod). */
function fechaValida(fecha: string): string {
  parseFechaCiclo(fecha);
  return fecha;
}

// ---- THE single creation entry point ----

/**
 * Domain rejection sentinel: thrown INSIDE the creation transaction so every effect
 * rolls back; the caller maps it to the lane's failure shape (tRPC 400 / replay).
 */
export class RechazoCorte extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "RechazoCorte";
  }
}

type EntradaCreacionCorte = {
  montoReal: string; // decimal string "1234.56" — the counted drawer cash
  fecha: string; // 'YYYY-MM-DD' Mazatlan business day (default: today)
  actor: string; // authenticated Usuario — legacy parity: ALWAYS the caller
  operationId?: string;
  // Audit identity for the router (HTTP) lane; the offline lane omits them.
  ip?: string | null;
  dispositivo?: string | null;
};

/**
 * C2+C3 central creation. Inside ONE tx:
 *  a. advisory lock `cortes_creacion` — serializes the (vendedor, fecha) decision;
 *  b. C1 teorico computed from the day's cash pagos (fresh, never cached — C4);
 *  c. C2 pre-check: no corte for (vendedor, fecha) — the DB partial unique is the
 *     last word (P2002 maps to the same rejection);
 *  d. insert corte (estado 'cerrado', diferencia = monto_real - monto_teorico in
 *     exact cents) + outbox row — one tx. Snapshot frozen forever (C3).
 *
 * Throws RechazoCorte(motivo) on domain failure.
 */
export async function adjudicarCorte(
  tx: Prisma.TransactionClient,
  entrada: EntradaCreacionCorte,
): Promise<CorteDto> {
  // a. Serialize the (vendedor, fecha) decision.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cortes_creacion'))`;

  // b. C1 exact teorico (server-owned; client amounts are never trusted for it).
  const teoricoCents = await montoTeoricoDelDia(tx, entrada.actor, entrada.fecha);
  const realCents = aCentavos(entrada.montoReal);
  const diferenciaCents = realCents - teoricoCents;

  // c. C2 pre-check under the lock (the partial unique is the final guarantee).
  const existente = await tx.corte.findFirst({
    where: { fkVendedor: entrada.actor, fecha: parseFechaCiclo(entrada.fecha) },
    select: { id: true },
  });
  if (existente) {
    throw new RechazoCorte(`${MSG_DUPLICADO} ${entrada.fecha}.`);
  }

  // d. Row + outbox — ONE tx. estado 'cerrado' (legacy create view parity).
  let creado;
  try {
    creado = await tx.corte.create({
      data: {
        fkVendedor: entrada.actor,
        fecha: parseFechaCiclo(entrada.fecha),
        montoTeorico: aDecimal(teoricoCents),
        montoReal: aDecimal(realCents),
        diferencia: aDecimal(diferenciaCents),
        estado: ESTADO_CORTE_CREACION,
      },
      include: { vendedor: { include: { persona: true } } },
    });
  } catch (error) {
    // A creator that raced past the pre-check still hits the partial unique.
    if ((error as { code?: string }).code === "P2002") {
      throw new RechazoCorte(`${MSG_DUPLICADO} ${entrada.fecha}.`);
    }
    throw error;
  }
  await escribirCambios(tx, entrada.actor, [
    { tablaOrigen: "corte", idFila: creado.id, operacion: "insert" },
  ]);
  await registrarLog(tx, {
    usuarioId: entrada.actor,
    accion: ACCION_LOG.CORTE_CREAR,
    entidad: "corte",
    entidadId: creado.id,
    ip: entrada.ip,
    dispositivo: entrada.dispositivo,
    detalle: { fecha: entrada.fecha, montoReal: entrada.montoReal },
  });
  return aDto(creado);
}

/** Online-lane runner with operationId idempotency (sync doc §7 — recolecciones parity). */
async function ejecutarCreacion(db: Database, entrada: EntradaCreacionCorte): Promise<CorteDto> {
  const { operationId, ...cuerpo } = entrada;
  try {
    return await db.$transaction(async (tx) => {
      if (operationId) {
        const previa = await tx.syncOperacion.findUnique({ where: { id: operationId } });
        if (previa) {
          const respuesta = (previa.respuesta ?? {}) as {
            corte?: CorteDto;
            motivo?: string;
          };
          if (previa.veredicto === "aplicada" && respuesta.corte) return respuesta.corte;
          throw new RechazoCorte(respuesta.motivo ?? "La operación fue rechazada previamente");
        }
      }
      const creado = await adjudicarCorte(tx, cuerpo);
      if (operationId) {
        await tx.syncOperacion.create({
          data: {
            id: operationId,
            fkUsuario: entrada.actor,
            coleccion: "cortes",
            docId: creado.id,
            op: "create",
            veredicto: "aplicada",
            respuesta: { corte: creado } as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return creado;
    });
  } catch (error) {
    if (error instanceof RechazoCorte) {
      if (operationId) {
        await db.syncOperacion
          .create({
            data: {
              id: operationId,
              fkUsuario: entrada.actor,
              coleccion: "cortes",
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

const inclVendedor = { vendedor: { include: { persona: true } } } as const;

export const cortesRouter = router({
  // Legacy /cortes/teorico/ parity: the UI preview of the day's cash total for the
  // CALLER (Admin cuts its own day, legacy parity — no create-for-other lane).
  // C4 note: v2 does NOT cache (single indexed aggregate; create never cached either).
  teorico: protectedProcedure
    .input(z.object({ fecha: FECHA.optional() }).optional())
    .query(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
      const fecha = fechaValida(input?.fecha ?? hoyNegocio(new Date()));
      const centavos = await montoTeoricoDelDia(ctx.db, ctx.user.id, fecha);
      return { fecha, montoTeorico: aDecimal(centavos) };
    }),

  // Legacy list parity: Admin sees all (optional fkVendedor/fecha filters); Vendedor
  // sees ONLY its own (a foreign fkVendedor filter is forced to self, legacy
  // queryset parity); Agricultor/Cliente have no read access (403).
  listar: protectedProcedure
    .input(
      z
        .object({
          fkVendedor: ID.optional(),
          fecha: FECHA.optional(),
          desde: FECHA.optional(),
          hasta: FECHA.optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
      const filtros: Prisma.CorteWhereInput = {
        ...(ctx.user.rol === ROLE.ADMIN && input?.fkVendedor
          ? { fkVendedor: input.fkVendedor }
          : {}),
        ...(ctx.user.rol === ROLE.VENDEDOR ? { fkVendedor: ctx.user.id } : {}),
        ...(input?.fecha
          ? { fecha: parseFechaCiclo(input.fecha) }
          : input?.desde || input?.hasta
            ? {
                fecha: {
                  ...(input?.desde ? { gte: parseFechaCiclo(input.desde) } : {}),
                  ...(input?.hasta ? { lte: parseFechaCiclo(input.hasta) } : {}),
                },
              }
            : {}),
      };
      const filas = await ctx.db.corte.findMany({
        where: filtros,
        include: inclVendedor,
        orderBy: [{ fecha: "desc" }, { creadoEn: "desc" }],
      });
      return filas.map(aDto);
    }),

  // Scoped detail (legacy retrieve parity: the same read scoping).
  detalle: protectedProcedure.input(z.object({ id: ID })).query(async ({ input, ctx }) => {
    asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
    const fila = await ctx.db.corte.findUnique({
      where: { id: input.id },
      include: inclVendedor,
    });
    if (!fila) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Corte no encontrado" });
    }
    if (ctx.user.rol === ROLE.VENDEDOR && fila.fkVendedor !== ctx.user.id) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Un vendedor solo puede consultar sus propios cortes.",
      });
    }
    return aDto(fila);
  }),

  // Online creation (legacy create parity; Admin/Vendedor — always for the CALLER).
  // operationId (sync doc §7): a retry with the SAME id returns the stored verdict
  // without re-executing effects. No CAS: legacy defines NO edit lane — the snapshot
  // is final at creation (C3), so the only conflict is the C2 duplicate (400).
  crear: protectedProcedure
    .input(
      z.object({
        montoReal: MONTO,
        fecha: FECHA.optional(),
        operationId: ID.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
      return ejecutarCreacion(ctx.db, {
        montoReal: input.montoReal,
        fecha: fechaValida(input.fecha ?? hoyNegocio(new Date())),
        actor: ctx.user.id,
        ip: ctx.ip,
        dispositivo: ctx.dispositivo,
        operationId: input.operationId,
      });
    }),
});
