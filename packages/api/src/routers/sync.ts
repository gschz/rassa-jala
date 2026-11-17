import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Database, Prisma } from "@rassa-jala/db";

import { protectedProcedure, router } from "../index";
import { ROLE } from "../context";

// Synchronization protocol — normative sources: docs/synchronization.md (§4 PULL, §5 PUSH,
// §7 idempotency, §8 deletions, §11 user isolation, §14 slice scope) and docs/database.md
// (§6.2 collection map, §6.3 document↔row transform, §7.1 M-1a/M-1b/M-8/M-9, SP-2/SP-3).

export const COLECCIONES = [
  "municipios",
  "localidades",
  "categorias",
  "unidades",
  // P0 Familias (M-9): scoped collections — admin sees all, members only their own
  // family data (§11: scoping revalidated per pull; checkpoints are per user).
  "familias",
  "membresias",
  "limites_credito",
] as const;
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

// P0 Familias (M-9, doc-deviation of §6.2's single `familias` row): three scoped PULL
// collections. `membresias` carries `correo` so a member's client can render the family
// roster (legacy chat semantics: members see co-members).
export interface FamiliaDoc {
  id: string;
  nombre: string;
  fkJefeUsuario: string | null;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

export interface MembresiaDoc {
  id: string;
  fkUsuario: string;
  fkFamilia: string;
  correo: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
  _deleted: boolean;
}

// Money travels as string (F-29: numeric → string, never float).
export interface LimiteCreditoDoc {
  id: string;
  monto: string;
  fkFamilia: string | null;
  fkUsuario: string | null;
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
export type FamiliaPullDoc = FamiliaDoc | TombstoneDoc;
export type MembresiaPullDoc = MembresiaDoc | TombstoneDoc;
export type LimiteCreditoPullDoc = LimiteCreditoDoc | TombstoneDoc;

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
type FilaFamilia = ElementoDe<Awaited<ReturnType<Database["familia"]["findMany"]>>>;
type FilaMembresia = ElementoDe<Awaited<ReturnType<Database["familiaUsuario"]["findMany"]>>>;
type FilaLimite = ElementoDe<Awaited<ReturnType<Database["limiteCredito"]["findMany"]>>>;

// ---- PULL (§4) ----

const GAP_WINDOW_MS = 60_000;
// slice-decision: margin N for gap evaluation over the base query (§4.3 "LIMIT límite + N").
const GAP_MARGIN = 20;

const TABLA_POR_COLECCION: Record<Coleccion, string> = {
  municipios: "municipio",
  localidades: "localidad",
  categorias: "categoria_producto",
  unidades: "unidad",
  familias: "familia",
  membresias: "familia_usuario",
  limites_credito: "limite_credito",
};

type DocPullDe<C extends Coleccion> = {
  municipios: MunicipioPullDoc;
  localidades: LocalidadPullDoc;
  categorias: CategoriaPullDoc;
  unidades: UnidadPullDoc;
  familias: FamiliaPullDoc;
  membresias: MembresiaPullDoc;
  limites_credito: LimiteCreditoPullDoc;
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
async function resolverDocumentos<C extends GlobalColeccion>(
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

function makePullProcedure<C extends GlobalColeccion>(coleccion: C) {
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

// ---- Scoped PULL (P0 Familias, M-9) ----

const GLOBAL_COLECCIONES = ["municipios", "localidades", "categorias", "unidades"] as const;
type GlobalColeccion = (typeof GLOBAL_COLECCIONES)[number];
const SCOPED_COLECCIONES = ["familias", "membresias", "limites_credito"] as const;
type ScopedColeccion = (typeof SCOPED_COLECCIONES)[number];

function aDocFamiliaScoped(fila: FilaFamilia): FamiliaDoc {
  return {
    id: fila.id,
    nombre: fila.nombre,
    fkJefeUsuario: fila.fkJefeUsuario,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

function aDocMembresiaScoped(fila: FilaMembresia & { usuario: { correo: string } }): MembresiaDoc {
  return {
    id: fila.id,
    fkUsuario: fila.fkUsuario,
    fkFamilia: fila.fkFamilia,
    correo: fila.usuario.correo,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

function aDocLimiteScoped(fila: FilaLimite): LimiteCreditoDoc {
  return {
    id: fila.id,
    monto: fila.monto.toFixed(2),
    fkFamilia: fila.fkFamilia,
    fkUsuario: fila.fkUsuario,
    estado: fila.estado,
    version: fila.version,
    actualizadoEn: fila.actualizadoEn.toISOString(),
    _deleted: !fila.estado,
  };
}

// Outbox sources per scoped collection. For non-admins, membership rows ('familia_usuario')
// ride along in `familias`/`limites_credito` as TRIGGERS: joining a family changes the
// user's visibility retroactively, and their checkpoint already passed that family's own
// outbox rows — the membership row re-delivers the affected family state.
function tablasOutboxDe(coleccion: ScopedColeccion, esAdmin: boolean): string[] {
  switch (coleccion) {
    case "familias":
      return esAdmin ? ["familia"] : ["familia", "familia_usuario"];
    case "membresias":
      return ["familia_usuario"];
    case "limites_credito":
      return esAdmin ? ["limite_credito"] : ["limite_credito", "familia_usuario"];
  }
}

// Admin → all; member → only their family docs. Own-membership triggers: join delivers
// the family doc; baja delivers a tombstone (the family is no longer the user's).
async function resolverFamiliasScoped(
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
): Promise<FamiliaPullDoc[]> {
  // id → tombstone? (the user left the family → _deleted doc)
  const objetivos = new Map<string, boolean>();
  if (esAdmin) {
    for (const fila of lote) objetivos.set(fila.idFila, false);
  } else {
    const propias = await db.familiaUsuario.findMany({
      where: { fkUsuario: idUsuario, estado: true },
      select: { fkFamilia: true },
    });
    const misFamilias = new Set(propias.map((p) => p.fkFamilia));
    const idsMembresia = lote
      .filter((f) => f.tablaOrigen === "familia_usuario")
      .map((f) => f.idFila);
    const filasMembresia = idsMembresia.length
      ? await db.familiaUsuario.findMany({ where: { id: { in: idsMembresia } } })
      : [];
    for (const fila of lote) {
      if (fila.tablaOrigen === "familia") {
        if (misFamilias.has(fila.idFila)) objetivos.set(fila.idFila, false);
        continue;
      }
      const membresia = filasMembresia.find((m) => m.id === fila.idFila);
      if (membresia?.fkUsuario === idUsuario) {
        objetivos.set(membresia.fkFamilia, !membresia.estado);
      }
    }
  }
  const idsReales = [...objetivos].filter(([, tombstone]) => !tombstone).map(([id]) => id);
  const filas = idsReales.length
    ? await db.familia.findMany({ where: { id: { in: idsReales } } })
    : [];
  const porId = new Map(filas.map((f) => [f.id, f]));
  const documentos = new Map<string, FamiliaPullDoc>();
  for (const [id, tombstone] of objetivos) {
    const fila = !tombstone ? porId.get(id) : undefined;
    documentos.set(id, fila ? aDocFamiliaScoped(fila) : { id, _deleted: true });
  }
  return [...documentos.values()];
}

// Admin → all; member → own membership rows + the CURRENT roster of their active family
// (a co-member row re-delivers the roster, covering members added before the checkpoint).
async function resolverMembresiasScoped(
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
): Promise<MembresiaPullDoc[]> {
  const documentos = new Map<string, MembresiaPullDoc>();
  const ids = [...new Set(lote.map((f) => f.idFila))];
  const filas = ids.length
    ? await db.familiaUsuario.findMany({
        where: { id: { in: ids } },
        include: { usuario: { select: { correo: true } } },
      })
    : [];
  const porId = new Map(filas.map((f) => [f.id, f]));
  const misFamilias = esAdmin
    ? new Set<string>()
    : new Set(
        (
          await db.familiaUsuario.findMany({
            where: { fkUsuario: idUsuario, estado: true },
            select: { fkFamilia: true },
          })
        ).map((p) => p.fkFamilia),
      );
  const rosters = new Set<string>();
  for (const fila of lote) {
    if (fila.operacion === "delete" || !porId.get(fila.idFila)) {
      documentos.set(fila.idFila, { id: fila.idFila, _deleted: true });
      continue;
    }
    const membresia = porId.get(fila.idFila)!;
    if (esAdmin || membresia.fkUsuario === idUsuario) {
      documentos.set(membresia.id, aDocMembresiaScoped(membresia));
    } else if (misFamilias.has(membresia.fkFamilia)) {
      rosters.add(membresia.fkFamilia);
    }
  }
  for (const fkFamilia of rosters) {
    const roster = await db.familiaUsuario.findMany({
      where: { fkFamilia },
      include: { usuario: { select: { correo: true } } },
    });
    for (const m of roster) documentos.set(m.id, aDocMembresiaScoped(m));
  }
  return [...documentos.values()];
}

// Admin → all; member → their own user limit + their family's limit. Own-membership
// triggers: join delivers the family limit; baja tombstones it (visibility ended).
async function resolverLimitesScoped(
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
): Promise<LimiteCreditoPullDoc[]> {
  const objetivos = new Map<string, boolean>();
  if (esAdmin) {
    for (const fila of lote) objetivos.set(fila.idFila, false);
  } else {
    const propias = await db.familiaUsuario.findMany({
      where: { fkUsuario: idUsuario, estado: true },
      select: { fkFamilia: true },
    });
    const misFamilias = new Set(propias.map((p) => p.fkFamilia));
    const idsLimite = lote.filter((f) => f.tablaOrigen === "limite_credito").map((f) => f.idFila);
    const filasLimite = idsLimite.length
      ? await db.limiteCredito.findMany({ where: { id: { in: idsLimite } } })
      : [];
    for (const fila of filasLimite) {
      const visible =
        fila.fkUsuario === idUsuario || (fila.fkFamilia != null && misFamilias.has(fila.fkFamilia));
      if (visible) objetivos.set(fila.id, false);
    }
    const idsMembresia = lote
      .filter((f) => f.tablaOrigen === "familia_usuario")
      .map((f) => f.idFila);
    const filasMembresia = idsMembresia.length
      ? await db.familiaUsuario.findMany({ where: { id: { in: idsMembresia } } })
      : [];
    for (const membresia of filasMembresia) {
      if (membresia.fkUsuario !== idUsuario) continue;
      const limite = await db.limiteCredito.findFirst({
        where: { fkFamilia: membresia.fkFamilia },
      });
      if (limite) objetivos.set(limite.id, !membresia.estado);
    }
  }
  const idsReales = [...objetivos].filter(([, tombstone]) => !tombstone).map(([id]) => id);
  const filas = idsReales.length
    ? await db.limiteCredito.findMany({ where: { id: { in: idsReales } } })
    : [];
  const porId = new Map(filas.map((f) => [f.id, f]));
  const documentos = new Map<string, LimiteCreditoPullDoc>();
  for (const [id, tombstone] of objetivos) {
    const fila = !tombstone ? porId.get(id) : undefined;
    documentos.set(id, fila ? aDocLimiteScoped(fila) : { id, _deleted: true });
  }
  return [...documentos.values()];
}

async function resolverScoped<C extends ScopedColeccion>(
  coleccion: C,
  lote: FilaSyncCambio[],
  db: Database,
  esAdmin: boolean,
  idUsuario: string,
): Promise<Array<DocPullDe<C>>> {
  switch (coleccion) {
    case "familias":
      return (await resolverFamiliasScoped(lote, db, esAdmin, idUsuario)) as Array<DocPullDe<C>>;
    case "membresias":
      return (await resolverMembresiasScoped(lote, db, esAdmin, idUsuario)) as Array<DocPullDe<C>>;
    case "limites_credito":
      return (await resolverLimitesScoped(lote, db, esAdmin, idUsuario)) as Array<DocPullDe<C>>;
  }
}

// Same PULL contract as the global factory (§4), but the batch selection and the
// resolution apply the §11 role+family scoping on every call.
function makeScopedPullProcedure<C extends ScopedColeccion>(coleccion: C) {
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
      const esAdmin = ctx.user.rol === ROLE.ADMIN;
      const checkpoint = BigInt(input.checkpoint?.seq ?? 0);
      const outbox = await ctx.db.syncCambio.findMany({
        where: {
          id: { gt: checkpoint },
          tablaOrigen: { in: tablasOutboxDe(coleccion, esAdmin) },
        },
        orderBy: { id: "asc" },
        take: input.limite + GAP_MARGIN,
      });

      const lote = cortarEnBrechas(outbox, checkpoint).slice(0, input.limite);
      const documentos = await resolverScoped(coleccion, lote, ctx.db, esAdmin, ctx.user.id);

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
// with offline write (slice: localidades, §14). Familias collections are PULL-only (admin
// mutations are online tRPC procedures).
export const syncRouter = router({
  municipios: router({ pull: makePullProcedure("municipios") }),
  localidades: router({
    pull: makePullProcedure("localidades"),
    push: makePushProcedure(),
  }),
  categorias: router({ pull: makePullProcedure("categorias") }),
  unidades: router({ pull: makePullProcedure("unidades") }),
  familias: router({ pull: makeScopedPullProcedure("familias") }),
  membresias: router({ pull: makeScopedPullProcedure("membresias") }),
  limites_credito: router({ pull: makeScopedPullProcedure("limites_credito") }),
});
