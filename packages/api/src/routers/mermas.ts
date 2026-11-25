import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Prisma } from "@rassa-jala/db";

import { ROLE, type Role } from "../context";
import { protectedProcedure, router } from "../index";
import { ACCION_LOG, registrarLog } from "../lib/registrar-log";
import type { Database } from "@rassa-jala/db";

// P1-C Mermas (docs/roadmap.md §6 P1-C; docs/database.md §3.5 rows + M-6/M-17,
// §4.1 FK policy, §6.2 online-confirm row; backend-audit M1–M3). Rules extracted
// from the legacy blueprint (legacy/rassa_back/rassa/blueprints/waste/{views,
// serializers}.py + tests/test_waste.py + models.py) — never copied:
//
// - Who registers: Admin AND Vendedor (HasRole(ADMIN, VENDEDOR)) — the Agricultor
//   is 403 (legacy test test_agricultor_cannot_create_merma). The vendedor may only
//   register mermas of pedidos HE owns (fk_pedido.fk_vendedor = caller; pedidos
//   without vendedor are 400 for him); the Admin may use any pedido.
// - Snapshot/shape fields: fk_producto_semanal, fk_pedido (required, NOT NULL —
//   legacy test test_merma_db_requiere_fk_pedido), cantidad (> 0), motivo
//   (required, ≤ 300), comentarios (optional; "" → null), fk_decision (required).
// - Domain validations (legacy serializer order): decision must exist AND be active
//   ("La decisión de merma no está activa."); the producto_semanal must belong to
//   the pedido ("El producto semanal no pertenece a este pedido." — DetallePedido
//   existence check); pedido must exist ("El pedido no existe." v2 wording of the
//   legacy invalid-pk 400).
// - STOCK FLOW (F-27 clarification — it IS defined in legacy): registration
//   decrements producto_semanal.stock inside ONE tx with select_for_update (row
//   lock, legacy views.py parity); stock < cantidad → 400 "Stock insuficiente.
//   Disponible: X, solicitado: Y."; exact stock → 0 is valid. NO reversal lane and
//   NO decision flow exist in legacy (decision_merma is a plain catalog; the
//   decision is just the loss's destination, e.g. Donar/Desechar) — none invented.
// - Merma is append-only: legacy ViewSet is List+Retrieve+Create — no edit/delete
//   lane; estado=true rows only (reads filter incluir_inactivos for audit).
// - decision_merma catalog: Admin-only CRUD (ModelViewSet HasRole(ADMIN)) with
//   soft-delete; unique `decision` (app-level UniqueValidator parity — UNIQUE in
//   v2, M-17). The merma form needs the decision list for the vendedor too: v2
//   serves that ONE read to Admin+Vendedor (the legacy delivered the catalog to
//   every client through the S1 global collection `decisiones_merma`, database.md
//   §6.2 — server-fetched parity, no RxDB collection: COL23).
// - The legacy /mermas/resumen/ aggregate report (Admin-only analytics) is NOT
//   part of this module's minimal completion: it is a report, not a workflow —
//   deferred to P1-F (roadmap §7 gap 18).
// - COL23 / sync (database.md §6.2): online-confirm module like cortes —
//   server-fetched reads, tRPC mutations with operationId idempotency, NO RxDB
//   collection (web at the 13-collection cap). Outbox rows ride in ONE tx (M-1a).

const ID = z.uuid();

// ---- DTO (database.md §6.3: dates ISO 8601) ----

type ProductoInfoDto = {
  id: string;
  producto: string;
  publicacion: string;
  stockRestante: number;
} | null;

type DecisionInfoDto = { id: string; nombre: string } | null;

type PedidoInfoDto = {
  id: string;
  // G1: human-readable order folio (M-19) instead of the raw UUID on the UI.
  // Nullable defensively: the FK column is NOT NULL (M-6) and folio is NOT NULL
  // (M-19), but the wire type stays tolerant for pedido-less rows.
  folio: string | null;
  cliente: string | null;
  estado: string | null;
  total: string;
} | null;

interface MermaDto {
  id: string;
  fkProductoSemanal: string | null;
  fkPedido: string;
  cantidad: number;
  motivo: string;
  comentarios: string | null;
  fkDecision: string | null;
  creadoEn: string;
  estado: boolean;
  productoInfo: ProductoInfoDto;
  decisionInfo: DecisionInfoDto;
  pedidoInfo: PedidoInfoDto;
}

interface DecisionMermaDto {
  id: string;
  decision: string;
  estado: boolean;
  creadoEn: string;
}

const inclMerma = {
  productoSemanal: { include: { producto: true } },
  decision: true,
  pedido: {
    include: {
      cliente: { include: { persona: true } },
      estadoPedido: true,
    },
  },
} as const satisfies Prisma.MermaInclude;

type FilaMerma = Prisma.MermaGetPayload<{ include: typeof inclMerma }>;

function aMermaDto(fila: FilaMerma): MermaDto {
  const ps = fila.productoSemanal;
  const pedido = fila.pedido;
  const persona = pedido.cliente?.persona ?? null;
  return {
    id: fila.id,
    fkProductoSemanal: fila.fkProductoSemanal,
    fkPedido: fila.fkPedido,
    cantidad: fila.cantidad,
    motivo: fila.motivo,
    comentarios: fila.comentarios,
    fkDecision: fila.fkDecision,
    creadoEn: fila.creadoEn.toISOString(),
    estado: fila.estado,
    productoInfo:
      ps && ps.producto
        ? {
            id: ps.id,
            producto: ps.producto.nombre,
            publicacion: ps.fkPublicacion,
            stockRestante: ps.stock,
          }
        : null,
    decisionInfo: fila.decision ? { id: fila.decision.id, nombre: fila.decision.decision } : null,
    pedidoInfo: pedido
      ? {
          id: pedido.id,
          folio: pedido.folio,
          cliente: persona ? `${persona.nombre} ${persona.apellidoPaterno}`.trim() : null,
          estado: pedido.estadoPedido?.nombre ?? null,
          total: pedido.total.toFixed(2),
        }
      : null,
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
const MSG_SOLO_OPERADORES = "Solo Vendedor o Admin consultan mermas";
const SOLO_ADMIN: Role[] = [ROLE.ADMIN];
const MSG_SOLO_ADMIN = "Solo el rol Admin gestiona las decisiones de merma";

/**
 * Domain rejection sentinel: thrown INSIDE the mutation transaction so every effect
 * rolls back; the runner maps it to the legacy HTTP code (400/404/500).
 */
export class RechazoMerma extends Error {
  constructor(
    motivo: string,
    readonly codigo: "BAD_REQUEST" | "NOT_FOUND" | "INTERNAL_SERVER_ERROR" = "BAD_REQUEST",
  ) {
    super(motivo);
    this.name = "RechazoMerma";
  }
}

// ---- THE single registration entry point ----

type EntradaRegistroMerma = {
  fkProductoSemanal: string;
  fkPedido: string;
  cantidad: number;
  motivo: string;
  comentarios: string | null;
  fkDecision: string;
  actor: string;
  esAdmin: boolean;
  // Audit identity for the router (HTTP) lane; the offline lane omits them.
  ip?: string | null;
  dispositivo?: string | null;
};

/**
 * Legacy create() central flow. Pre-transaction serializer validations (legacy
 * ordering), then ONE tx:
 *  a. row lock `SELECT ... FOR UPDATE` on producto_semanal (legacy select_for_update
 *     parity — serializes the stock decision without an extra advisory lock);
 *  b. stock check with the exact legacy message ("Stock insuficiente. Disponible:
 *     X, solicitado: Y.") + conditional decrement;
 *  c. merma insert + outbox rows (merma insert + producto_semanal update) — one tx.
 *
 * Throws RechazoMerma(motivo, codigo) on domain failure.
 */
async function adjudicarMerma(
  tx: Prisma.TransactionClient,
  entrada: EntradaRegistroMerma,
): Promise<MermaDto> {
  // Legacy serializer ordering: fk_decision validity first, then the pedido checks.
  const decision = await tx.decisionMerma.findUnique({
    where: { id: entrada.fkDecision },
    select: { id: true, estado: true },
  });
  if (!decision) throw new RechazoMerma("La decisión de merma no existe.");
  if (!decision.estado) throw new RechazoMerma("La decisión de merma no está activa.");

  const pedido = await tx.pedidoCabecera.findUnique({
    where: { id: entrada.fkPedido },
    select: { id: true, fkVendedor: true },
  });
  if (!pedido) throw new RechazoMerma("El pedido no existe.");
  // Legacy create() ownership rule: the vendedor may only register mermas of HIS
  // pedidos (null fk_vendedor counts as foreign for him); the Admin bypasses.
  if (!entrada.esAdmin && pedido.fkVendedor !== entrada.actor) {
    throw new RechazoMerma("El pedido no pertenece al vendedor autenticado.");
  }

  // Legacy validate(): the producto_semanal must be a line of THIS pedido.
  const semanal = await tx.productoSemanal.findUnique({
    where: { id: entrada.fkProductoSemanal },
    select: { id: true, stock: true },
  });
  if (!semanal) throw new RechazoMerma("El producto semanal no existe.", "NOT_FOUND");
  const pertenece = await tx.detallePedido.findFirst({
    where: { fkPedido: entrada.fkPedido, fkProductoSemanal: entrada.fkProductoSemanal },
    select: { id: true },
  });
  if (!pertenece) {
    throw new RechazoMerma("El producto semanal no pertenece a este pedido.");
  }

  // a. Row lock (legacy select_for_update): serializes concurrent decrements —
  //    exactly one of two racing mermas that together exceed the stock wins.
  await tx.$executeRaw`SELECT id FROM producto_semanal WHERE id = ${entrada.fkProductoSemanal}::uuid FOR UPDATE`;
  const aplicado = await tx.productoSemanal.updateMany({
    where: { id: entrada.fkProductoSemanal, stock: { gte: entrada.cantidad } },
    data: { stock: { decrement: entrada.cantidad }, version: { increment: 1 } },
  });
  if (aplicado.count === 0) {
    // Under the row lock the read stock IS the available stock (legacy message).
    const { stock } = (await tx.productoSemanal.findUniqueOrThrow({
      where: { id: entrada.fkProductoSemanal },
      select: { stock: true },
    })) as { stock: number };
    throw new RechazoMerma(
      `Stock insuficiente. Disponible: ${stock}, solicitado: ${entrada.cantidad}.`,
    );
  }

  // c. Merma + outbox — ONE tx.
  const creado = await tx.merma.create({
    data: {
      fkProductoSemanal: entrada.fkProductoSemanal,
      fkPedido: entrada.fkPedido,
      cantidad: entrada.cantidad,
      motivo: entrada.motivo,
      comentarios: entrada.comentarios,
      fkDecision: entrada.fkDecision,
    },
    include: inclMerma,
  });
  await escribirCambios(tx, entrada.actor, [
    { tablaOrigen: "merma", idFila: creado.id, operacion: "insert" },
    { tablaOrigen: "producto_semanal", idFila: entrada.fkProductoSemanal, operacion: "update" },
  ]);
  await registrarLog(tx, {
    usuarioId: entrada.actor,
    accion: ACCION_LOG.MERMA_REGISTRAR,
    entidad: "merma",
    entidadId: creado.id,
    ip: entrada.ip,
    dispositivo: entrada.dispositivo,
    detalle: {
      fkPedido: entrada.fkPedido,
      fkProductoSemanal: entrada.fkProductoSemanal,
      cantidad: entrada.cantidad,
      motivo: entrada.motivo,
    },
  });
  return aMermaDto(creado);
}

// ---- online-lane runner with operationId idempotency (liquidaciones parity) ----

async function guardarRechazo(
  db: Database,
  operationId: string,
  actor: string,
  op: string,
  motivo: string,
  codigo: RechazoMerma["codigo"],
): Promise<void> {
  await db.syncOperacion
    .create({
      data: {
        id: operationId,
        fkUsuario: actor,
        coleccion: "mermas",
        docId: crypto.randomUUID(),
        op,
        veredicto: "rechazada",
        respuesta: { motivo, codigo },
      },
    })
    .catch(() => undefined); // a concurrent replay already stored the verdict
}

async function ejecutarOperacion<T>(
  db: Database,
  params: {
    actor: string;
    operationId?: string;
    op: string;
    docId: (resultado: T) => string;
    correr: (tx: Prisma.TransactionClient) => Promise<T>;
    empaquetar: (resultado: T) => Prisma.InputJsonValue;
  },
): Promise<T> {
  const { operationId, actor } = params;
  try {
    return await db.$transaction(async (tx) => {
      if (operationId) {
        const previa = await tx.syncOperacion.findUnique({ where: { id: operationId } });
        if (previa) {
          const respuesta = (previa.respuesta ?? {}) as {
            resultado?: T;
            motivo?: string;
            codigo?: RechazoMerma["codigo"];
          };
          if (previa.veredicto === "aplicada" && respuesta.resultado !== undefined) {
            return respuesta.resultado as T;
          }
          throw new RechazoMerma(
            respuesta.motivo ?? "La operación fue rechazada previamente",
            respuesta.codigo ?? "BAD_REQUEST",
          );
        }
      }
      const resultado = await params.correr(tx);
      if (operationId) {
        await tx.syncOperacion.create({
          data: {
            id: operationId,
            fkUsuario: actor,
            coleccion: "mermas",
            docId: params.docId(resultado),
            op: params.op,
            veredicto: "aplicada",
            respuesta: { resultado: params.empaquetar(resultado) },
          },
        });
      }
      return resultado;
    });
  } catch (error) {
    if (error instanceof RechazoMerma) {
      if (operationId) {
        await guardarRechazo(db, operationId, actor, params.op, error.message, error.codigo);
      }
      throw new TRPCError({ code: error.codigo, message: error.message });
    }
    throw error;
  }
}

// ---- procedures ----

export const mermasRouter = router({
  decisiones: {
    // Catalog read for the registration form. Legacy had the S1 global collection
    // `decisiones_merma` (§6.2) feeding every client; v2 serves it server-fetched to
    // the module's operators (Admin+Vendedor). incluirInactivos=true is Admin-only
    // audit parity (legacy ?incluir_inactivos=).
    listar: protectedProcedure
      .input(z.object({ incluirInactivos: z.boolean().optional() }).optional())
      .query(async ({ input, ctx }) => {
        asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
        const incluir = input?.incluirInactivos === true && ctx.user.rol === ROLE.ADMIN;
        const filas = await ctx.db.decisionMerma.findMany({
          where: incluir ? {} : { estado: true },
          orderBy: { decision: "asc" },
        });
        return filas.map((f) => ({
          id: f.id,
          decision: f.decision,
          estado: f.estado,
          creadoEn: f.creadoEn.toISOString(),
        })) satisfies DecisionMermaDto[];
      }),

    // Legacy create (Admin-only): unique `decision` — the DB UNIQUE is the final
    // word; P2002 maps to the clean 400.
    crear: protectedProcedure
      .input(z.object({ decision: z.string().min(1).max(50) }))
      .mutation(async ({ input, ctx }) => {
        asegurarRol(ctx.user.rol, SOLO_ADMIN, MSG_SOLO_ADMIN);
        try {
          const fila = await ctx.db.decisionMerma.create({ data: { decision: input.decision } });
          await escribirCambios(ctx.db, ctx.user.id, [
            { tablaOrigen: "decision_merma", idFila: fila.id, operacion: "insert" },
          ]);
          return {
            id: fila.id,
            decision: fila.decision,
            estado: fila.estado,
            creadoEn: fila.creadoEn.toISOString(),
          } satisfies DecisionMermaDto;
        } catch (error) {
          if ((error as { code?: string }).code === "P2002") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `La decisión "${input.decision}" ya existe.`,
            });
          }
          throw error;
        }
      }),

    // Legacy partial update (Admin-only). No CAS: legacy defines no versioned edit
    // lane — the rename is a plain catalog field (unique re-checked).
    editar: protectedProcedure
      .input(z.object({ id: ID, decision: z.string().min(1).max(50) }))
      .mutation(async ({ input, ctx }) => {
        asegurarRol(ctx.user.rol, SOLO_ADMIN, MSG_SOLO_ADMIN);
        try {
          const fila = await ctx.db.decisionMerma.update({
            where: { id: input.id },
            data: { decision: input.decision, version: { increment: 1 } },
          });
          await escribirCambios(ctx.db, ctx.user.id, [
            { tablaOrigen: "decision_merma", idFila: fila.id, operacion: "update" },
          ]);
          return {
            id: fila.id,
            decision: fila.decision,
            estado: fila.estado,
            creadoEn: fila.creadoEn.toISOString(),
          } satisfies DecisionMermaDto;
        } catch (error) {
          if ((error as { code?: string }).code === "P2002") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `La decisión "${input.decision}" ya existe.`,
            });
          }
          if ((error as { code?: string }).code === "P2025") {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Decisión de merma no encontrada.",
            });
          }
          throw error;
        }
      }),

    // Legacy destroy = soft-delete (Admin-only): estado=false; inactive decisions
    // are rejected at registration ("La decisión de merma no está activa.").
    desactivar: protectedProcedure.input(z.object({ id: ID })).mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, SOLO_ADMIN, MSG_SOLO_ADMIN);
      try {
        const fila = await ctx.db.decisionMerma.update({
          where: { id: input.id },
          data: { estado: false, version: { increment: 1 } },
        });
        await escribirCambios(ctx.db, ctx.user.id, [
          { tablaOrigen: "decision_merma", idFila: fila.id, operacion: "update" },
        ]);
        return { id: fila.id, estado: fila.estado } as const;
      } catch (error) {
        if ((error as { code?: string }).code === "P2025") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Decisión de merma no encontrada.",
          });
        }
        throw error;
      }
    }),
  },

  // Legacy list parity: Admin sees all; Vendedor sees ONLY mermas of his pedidos
  // (queryset filter fk_pedido__fk_vendedor_id = self). Filters: fkPedido,
  // incluirInactivos (audit).
  listar: protectedProcedure
    .input(
      z
        .object({
          fkPedido: ID.optional(),
          incluirInactivos: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
      const filtros: Prisma.MermaWhereInput = {
        ...(ctx.user.rol === ROLE.VENDEDOR ? { pedido: { fkVendedor: ctx.user.id } } : {}),
        ...(input?.fkPedido ? { fkPedido: input.fkPedido } : {}),
        ...(input?.incluirInactivos ? {} : { estado: true }),
      };
      const filas = await ctx.db.merma.findMany({
        where: filtros,
        include: inclMerma,
        orderBy: { creadoEn: "desc" },
      });
      return filas.map(aMermaDto);
    }),

  // Scoped detail (legacy retrieve parity: the same queryset — a foreign merma is
  // simply not found for a vendedor, legacy 404).
  detalle: protectedProcedure.input(z.object({ id: ID })).query(async ({ input, ctx }) => {
    asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
    const fila = await ctx.db.merma.findUnique({
      where: { id: input.id },
      include: inclMerma,
    });
    if (!fila) throw new TRPCError({ code: "NOT_FOUND", message: "Merma no encontrada." });
    if (ctx.user.rol === ROLE.VENDEDOR && fila.pedido.fkVendedor !== ctx.user.id) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Merma no encontrada." });
    }
    return aMermaDto(fila);
  }),

  // Legacy create (Admin/Vendedor). operationId (sync §7): a replay with the SAME
  // id returns the stored verdict without re-executing effects — critical here
  // because the stock decrement MUST not happen twice.
  registrar: protectedProcedure
    .input(
      z.object({
        fkProductoSemanal: ID,
        fkPedido: ID,
        cantidad: z.number().int().min(1, "La cantidad debe ser mayor a 0."),
        motivo: z.string().min(1, "El motivo es obligatorio.").max(300),
        comentarios: z.string().max(2000).optional().nullable(),
        fkDecision: ID,
        operationId: ID.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      asegurarRol(ctx.user.rol, OPERADORES, MSG_SOLO_OPERADORES);
      const comentarios = input.comentarios?.trim() ? input.comentarios : null;
      return ejecutarOperacion<MermaDto>(ctx.db, {
        operationId: input.operationId,
        op: "registrar",
        actor: ctx.user.id,
        docId: (r) => r.id,
        correr: (tx) =>
          adjudicarMerma(tx, {
            fkProductoSemanal: input.fkProductoSemanal,
            fkPedido: input.fkPedido,
            cantidad: input.cantidad,
            motivo: input.motivo,
            comentarios,
            fkDecision: input.fkDecision,
            actor: ctx.user.id,
            esAdmin: ctx.user.rol === ROLE.ADMIN,
            ip: ctx.ip,
            dispositivo: ctx.dispositivo,
          }),
        empaquetar: (r) => r as unknown as Prisma.InputJsonValue,
      });
    }),
});
