import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Database, Prisma } from "@rassa-jala/db";

import { protectedProcedure, router } from "../index";
import { ROLE } from "../context";

// Synchronization protocol — normative sources: docs/synchronization.md (§4 PULL, §5 PUSH,
// §7 idempotency, §8 deletions, §14 slice scope) and docs/database.md (§6.2 collection map,
// §6.3 document↔row transform, §7.1 M-1a/M-1b, SP-2/SP-3).

export const COLECCIONES = ["municipios", "localidades", "categorias", "unidades"] as const;
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

export interface ResultadoPush {
  operationId: string;
  docId: string;
  veredicto: Veredicto;
  motivo?: string;
  estadoServidor?: LocalidadPullDoc;
}

// ---- Prisma row types ----

type ElementoDe<A> = A extends readonly (infer T)[] ? T : never;
type FilaSyncCambio = ElementoDe<Awaited<ReturnType<Database["syncCambio"]["findMany"]>>>;
type FilaSyncOperacion = ElementoDe<Awaited<ReturnType<Database["syncOperacion"]["findMany"]>>>;
type FilaLocalidad = ElementoDe<Awaited<ReturnType<Database["localidad"]["findMany"]>>>;
type FilaMunicipio = ElementoDe<Awaited<ReturnType<Database["municipio"]["findMany"]>>>;
type FilaCategoria = ElementoDe<Awaited<ReturnType<Database["categoriaProducto"]["findMany"]>>>;
type FilaUnidad = ElementoDe<Awaited<ReturnType<Database["unidad"]["findMany"]>>>;

// ---- PULL (§4) ----

const GAP_WINDOW_MS = 60_000;
// slice-decision: margin N for gap evaluation over the base query (§4.3 "LIMIT límite + N").
const GAP_MARGIN = 20;

const TABLA_POR_COLECCION: Record<Coleccion, string> = {
  municipios: "municipio",
  localidades: "localidad",
  categorias: "categoria_producto",
  unidades: "unidad",
};

type DocPullDe<C extends Coleccion> = {
  municipios: MunicipioPullDoc;
  localidades: LocalidadPullDoc;
  categorias: CategoriaPullDoc;
  unidades: UnidadPullDoc;
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

function aDocMunicipio(fila: FilaMunicipio): MunicipioDoc {
  return {
    id: fila.id,
    nombre: fila.nombre,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
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
  return {
    id: fila.id,
    nombre: fila.nombre,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
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

// Resolve the CURRENT state of each outbox row's business row; operacion='delete' or a missing row
// yields a minimal tombstone (§4.3). The casts bridge the C↔case correlation TypeScript cannot
// express; each is checked by the switch itself.
async function resolverDocumentos<C extends Coleccion>(
  coleccion: C,
  lote: FilaSyncCambio[],
  db: Database,
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
  }
}

function makePullProcedure<C extends Coleccion>(coleccion: C) {
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
      const documentos = await resolverDocumentos(coleccion, lote, ctx.db);

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
  estadoServidor?: LocalidadPullDoc;
};

function tombstoneLocalidad(operacion: OperacionPushInput): LocalidadPullDoc {
  // §5.1 — a rejected create without a server row synthesizes a tombstone so the client's
  // server-wins conflictHandler removes the local document instead of leaving a ghost.
  return { ...operacion.nuevoEstado, id: operacion.docId, _deleted: true };
}

function registrarOperacion(
  tx: Prisma.TransactionClient,
  operacion: OperacionPushInput,
  idUsuario: string,
  veredicto: Veredicto,
  respuesta: RespuestaOperacion | null,
): Promise<unknown> {
  return tx.syncOperacion.create({
    data: {
      id: operacion.operationId,
      fkUsuario: idUsuario,
      coleccion: "localidades",
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
        // §5.2 step 4 — create requires a nonexistent row; otherwise conflict with real state.
        if (actual) {
          const estadoServidor = aDocLocalidad(actual);
          await registrarOperacion(tx, operacion, idUsuario, VEREDICTO.CONFLICTO, {
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
          await registrarOperacion(tx, operacion, idUsuario, VEREDICTO.RECHAZADA, {
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
        await registrarOperacion(tx, operacion, idUsuario, VEREDICTO.APLICADA, null);
        return { ...base, veredicto: VEREDICTO.APLICADA };
      }

      if (!actual) {
        if (operacion.op === OPERACION.DELETE) {
          // Deleting a row that never existed server-side already achieves the end state.
          const motivo = "delete of a nonexistent row; no-op";
          await registrarOperacion(tx, operacion, idUsuario, VEREDICTO.APLICADA, { motivo });
          return { ...base, veredicto: VEREDICTO.APLICADA, motivo };
        }
        const estadoServidor = tombstoneLocalidad(operacion);
        const motivo = "row does not exist on the server";
        await registrarOperacion(tx, operacion, idUsuario, VEREDICTO.RECHAZADA, {
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
          await registrarOperacion(tx, operacion, idUsuario, VEREDICTO.RECHAZADA, {
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
        await registrarOperacion(tx, operacion, idUsuario, VEREDICTO.CONFLICTO, { estadoServidor });
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
        await registrarOperacion(tx, operacion, idUsuario, VEREDICTO.CONFLICTO, { estadoServidor });
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
      await registrarOperacion(tx, operacion, idUsuario, VEREDICTO.APLICADA, null);
      return { ...base, veredicto: VEREDICTO.APLICADA };
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

// §3.1/§4.1 — one procedure per collection via a common factory; PUSH only registers collections
// with offline write (slice: localidades, §14).
export const syncRouter = router({
  municipios: router({ pull: makePullProcedure("municipios") }),
  localidades: router({
    pull: makePullProcedure("localidades"),
    push: makePushProcedure(),
  }),
  categorias: router({ pull: makePullProcedure("categorias") }),
  unidades: router({ pull: makePullProcedure("unidades") }),
});
