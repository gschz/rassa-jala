import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Prisma } from "@rassa-jala/db";

import { ROLE, type Context } from "../context";
import {
  MIME_MEDIA,
  asegurarFirmaMedia,
  decodificarBase64Media,
  esMimeMedia,
  extensionCoincideMedia,
  mimeCanonico,
  type MimeMedia,
} from "../lib/media-firma";
import { protectedProcedure, router } from "../index";
import type { Database } from "@rassa-jala/db";
import {
  MIME_PERMITIDOS,
  asegurarFirmaImagen,
  decodificarBase64,
  extensionCoincide,
  type MimePermitido,
} from "./productos";

// P1-D Chat (docs/roadmap.md §6 P1-D; docs/database.md §3.6 mensaje row + M-18,
// §6.2 S3 bidirectional; docs/synchronization.md §6/§8/§9). Rules extracted from the
// legacy blueprint (legacy/rassa_back/rassa/blueprints/chat/{views,serializers}.py
// + models.py + settings.CHAT_EDIT_WINDOW_MINUTES) — never copied:
//
// - SCOPING: every read/send lane requires an ACTIVE conversation + an `integrantes`
//   row (legacy _get_active_conversation_for_user / serializer checks). v2 keeps the
//   legacy message ("No eres miembro de esta conversación."); v2 maps the legacy
//   NotFound/ValidationError pair to a uniform 403 (task decision 2026-11-20) —
//   doc-deviation: legacy sent 400 on non-member send and 404 on non-member read.
// - READ MARKING (leido): bulk per-message boolean, monotonic — PATCH marks ALL
//   non-own unread rows true (never false again). Multi-device conflict surface is
//   resolved server-side: `leido` only moves false→true (S3 minimal merge, sync §6).
// - EDIT WINDOW (15 min): CONFIRMED in legacy (settings.CHAT_EDIT_WINDOW_MINUTES=15)
//   for BOTH edit ("Solo puedes editar mensajes con menos de 15 minutos de antigüedad.")
//   and delete ("Solo se pueden eliminar mensajes de los últimos 15 minutos.").
//   Ownership: "No puedes editar/eliminar un mensaje que no te pertenece."
// - No CAS on the online edit/delete lanes: legacy defines no versioned edit lane
//   (plain save after the ownership/window checks) — the versioning lives in the S3
//   push path (sync router `mensajes`), where stale pushes return conflicto.
// - Outbox M-1a in ONE tx on every write; operationId idempotency (sync §7) on the
//   mutating lanes; WS notification (Bun hub via the injected `notificador`) fires
//   AFTER the tx commits, to the OTHER integrantes (read-only notifier — S3 stays
//   the source of truth; polling is the fallback).
// - Attachments (T17, gap-pass-7): ONE image per message. The BYTES upload rides the
//   multipart bridge POST /upload/documentos → chat.documentos.upload (D-1 storage,
//   `documento` metadata row); the MESSAGE (tipo "imagen" + archivoUrl) rides the
//   SAME lanes as texto (online `enviar` / S3 push). The asymmetric split is by
//   design: archivoUrl is a reference — the storage file never enters any sync lane.

const ID = z.uuid();
// Legacy min_length=1; an upper bound keeps a runaway client from flooding a row.
// Optional since T17: image-only messages (legacy parity — the legacy m2m attached
// files to contenido-less messages) carry no text; the DB CHECK
// `mensaje_contenido_no_vacia` allows NULL. A texto message still requires it.
const CONTENIDO = z.string().trim().min(1, "El contenido es obligatorio.").max(2000);
// Legacy CHAT_EDIT_WINDOW_MINUTES = 15 (settings.py:243).
const VENTANA_EDICION_MS = 15 * 60 * 1000;
// T17: the column keeps the FULL legacy domain (texto|audio|imagen|video); T6
// (gap-pass-9) wires audio|video to the SAME online lanes as imagen — the upload
// endpoint now validates media signatures (lib/media-firma, ≤15 MiB). The offline
// push lane stays TEXT-ONLY (a draft cannot upload bytes while offline).
const TIPO_MENSAJE = z.enum(["texto", "imagen", "audio", "video"]).default("texto");

// T6 §7.21 (listarContactos): the user projection every contact source selects.
// Inlined per query (NOT a shared const): a module-scope select object does not
// assign against the generated client's contextual ExtArgs (verified probe).

type MensajeDto = {
  id: string;
  fkConversacion: string;
  fkAutor: string | null;
  autorNombre: string | null;
  contenido: string | null;
  tipo: string;
  archivoUrl: string | null;
  leido: boolean;
  editado: boolean;
  creadoEn: string;
};

type ConversacionDto = {
  id: string;
  tipo: "grupal" | "privada";
  nombre: string;
  esFamilia: boolean;
  /** T6 §7.21: manual group (grupal without familia) — rename/member UI applies. */
  manual: boolean;
  /** T6 §7.21: the caller's integrantes row is the creator's (rol "admin"). */
  administrable: boolean;
  integrantes: Array<{ id: string; nombre: string; rol: string }>;
  ultimoMensaje: string | null;
  ultimoMensajeCreadoEn: string | null;
  noLeidos: number;
};

const inclMensaje = {
  conversacion: true,
  autor: { include: { persona: true } },
} as const satisfies Prisma.MensajeInclude;

type FilaMensaje = Prisma.MensajeGetPayload<{ include: typeof inclMensaje }>;

function aMensajeDto(fila: FilaMensaje): MensajeDto {
  const persona = fila.autor?.persona ?? null;
  return {
    id: fila.id,
    fkConversacion: fila.fkConversacion,
    fkAutor: fila.fkAutor,
    autorNombre: persona ? `${persona.nombre} ${persona.apellidoPaterno}`.trim() : null,
    contenido: fila.contenido,
    tipo: fila.tipo,
    archivoUrl: fila.archivoUrl,
    leido: fila.leido,
    editado: fila.editado,
    creadoEn: fila.creadoEn.toISOString(),
  };
}

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

/**
 * Scoping gate (legacy parity, uniform 403): the conversation must exist, be active
 * and carry an integrantes row for the caller.
 */
async function asegurarIntegrante(
  db: Database,
  conversacionId: string,
  idUsuario: string,
): Promise<void> {
  const conversacion = await db.conversacion.findUnique({
    where: { id: conversacionId },
    select: {
      estado: true,
      integrantes: { where: { fkUsuario: idUsuario }, select: { id: true } },
    },
  });
  if (!conversacion?.estado || conversacion.integrantes.length === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No eres miembro de esta conversación.",
    });
  }
}

/** Domain rejection sentinel: thrown INSIDE the tx so every effect rolls back. */
export class RechazoChat extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "RechazoChat";
  }
}

async function guardarRechazo(
  db: Database,
  operationId: string,
  actor: string,
  op: string,
  motivo: string,
): Promise<void> {
  await db.syncOperacion
    .create({
      data: {
        id: operationId,
        fkUsuario: actor,
        coleccion: "mensajes",
        docId: crypto.randomUUID(), // docId unknown for pre-row rejections (mermas parity)
        op,
        veredicto: "rechazada",
        respuesta: { motivo },
      },
    })
    .catch(() => undefined); // a concurrent replay already stored the verdict
}

/** Online-lane runner with operationId idempotency (mermas parity). */
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
  try {
    return await db.$transaction(async (tx) => {
      if (params.operationId) {
        const previa = await tx.syncOperacion.findUnique({ where: { id: params.operationId } });
        if (previa) {
          const respuesta = (previa.respuesta ?? {}) as {
            resultado?: T;
            motivo?: string;
          };
          if (previa.veredicto === "aplicada" && respuesta.resultado !== undefined) {
            return respuesta.resultado as T;
          }
          throw new RechazoChat(respuesta.motivo ?? "La operación fue rechazada previamente");
        }
      }
      const resultado = await params.correr(tx);
      if (params.operationId) {
        await tx.syncOperacion.create({
          data: {
            id: params.operationId,
            fkUsuario: params.actor,
            coleccion: "mensajes",
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
    if (error instanceof RechazoChat) {
      if (params.operationId) {
        await guardarRechazo(db, params.operationId, params.actor, params.op, error.message);
      }
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    throw error;
  }
}

// ---- T6 (gap-pass-9) §7.21 manual groups (legacy ConversacionGrupalCreateView /
// RenombrarView / AgregarIntegranteView / IntegranteRemoveView, reduced) ----

/**
 * Manual-group admin gate (legacy _require_chat_admin reduced): only a MANUAL group
 * (tipo grupal WITHOUT familia — family chats are family-administered, legacy
 * "No se pueden agregar integrantes manualmente a un chat familiar"), active, and the
 * caller must be its creator (integrantes.rol = "admin") or a platform Admin. The
 * uniform shape keeps legacy's 404/403 split on ONE surface: unknown/manual-only
 * violations → 404, non-admin member → 403 (v2 uniform-error decision, chat.ts header).
 */
async function asegurarAdminGrupo(
  db: Database,
  conversacionId: string,
  idUsuario: string,
  rolPlataforma: string,
): Promise<void> {
  const conversacion = await db.conversacion.findUnique({
    where: { id: conversacionId },
    select: {
      tipo: true,
      fkFamilia: true,
      estado: true,
      integrantes: { where: { fkUsuario: idUsuario }, select: { rol: true } },
    },
  });
  if (!conversacion?.estado || !conversacion.tipo || conversacion.fkFamilia != null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Conversación grupal no encontrada." });
  }
  if (rolPlataforma !== ROLE.ADMIN && conversacion.integrantes[0]?.rol !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Solo el administrador del chat puede realizar esta acción.",
    });
  }
}

/** Resolves the target users or reports the missing ones (legacy "Algunos usuarios no existen."). */
async function asegurarUsuariosActivos(db: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const existentes = await db.usuario.findMany({
    where: { id: { in: ids }, estado: true },
    select: { id: true },
  });
  if (existentes.length !== ids.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Algunos usuarios no existen." });
  }
}

/** WS "grupo" event: recipients invalidate their conversation list (no payload data). */
function avisarGrupo(
  notificador: Context["notificador"],
  destinatarios: string[],
  conversacionId: string,
): void {
  if (destinatarios.length === 0) return;
  notificador.publicar(destinatarios, { tipo: "grupo", conversacionId, idMensaje: null });
}

export const chatRouter = router({
  // Legacy ConversacionListView: conversations where the caller is a member; per-row
  // last message + unread count (authors other than the caller, active rows only).
  listarConversaciones: protectedProcedure.query(async ({ ctx }) => {
    const membresias = await ctx.db.integrante.findMany({
      where: { fkUsuario: ctx.user.id, conversacion: { estado: true } },
      select: {
        conversacion: {
          select: {
            id: true,
            tipo: true,
            fkFamilia: true,
            nombre: true,
            familia: { select: { nombre: true } },
            integrantes: {
              select: {
                fkUsuario: true,
                rol: true,
                usuario: {
                  select: {
                    persona: {
                      select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true },
                    },
                    correo: true,
                  },
                },
              },
            },
            mensajes: {
              where: { estado: true },
              orderBy: { creadoEn: "desc" },
              take: 1,
              select: { contenido: true, tipo: true, creadoEn: true },
            },
          },
        },
      },
    });

    const noLeidosAgregado =
      membresias.length > 0
        ? await ctx.db.mensaje.groupBy({
            by: ["fkConversacion"],
            _count: { _all: true },
            where: {
              fkConversacion: { in: membresias.map((m) => m.conversacion.id) },
              estado: true,
              leido: false,
              fkAutor: { not: ctx.user.id },
            },
          })
        : [];
    // Gap 22: ONE GROUP BY replaces the per-conversation count (N+1); contract unchanged.
    const noLeidosPor = new Map(noLeidosAgregado.map((g) => [g.fkConversacion, g._count._all]));

    const dtos: ConversacionDto[] = [];
    // T17/T6: an attachment-only last message (contenido NULL) projects a label so
    // the envelope stays a string ("Sin mensajes" would otherwise mislead).
    const ETIQUETA_ADJUNTO: Record<string, string> = {
      imagen: "Imagen",
      audio: "Audio",
      video: "Video",
    };
    for (const { conversacion } of membresias) {
      const ultimo = conversacion.mensajes[0] ?? null;
      const noLeidos = noLeidosPor.get(conversacion.id) ?? 0;
      const otros = conversacion.integrantes.filter((i) => i.fkUsuario !== ctx.user.id);
      let nombre: string;
      if (conversacion.tipo) {
        // T6: manual groups carry their own nombre; family chats project
        // familia.nombre (their nombre column stays NULL, legacy serializer parity).
        nombre =
          conversacion.nombre?.trim() ||
          conversacion.familia?.nombre ||
          (otros[0]
            ? `${otros[0].usuario.persona.nombre} ${otros[0].usuario.persona.apellidoPaterno}`.trim()
            : "Sin nombre");
      } else {
        nombre = otros[0]
          ? `${otros[0].usuario.persona.nombre} ${otros[0].usuario.persona.apellidoPaterno}`.trim()
          : "Sin nombre";
      }
      const ultimoMensaje =
        ultimo == null
          ? null
          : (ultimo.contenido ??
            (ultimo.tipo === "texto" ? null : ETIQUETA_ADJUNTO[ultimo.tipo]) ??
            null);
      dtos.push({
        id: conversacion.id,
        tipo: conversacion.tipo ? "grupal" : "privada",
        nombre,
        esFamilia: conversacion.fkFamilia != null,
        manual: conversacion.tipo && conversacion.fkFamilia == null,
        administrable:
          conversacion.integrantes.find((i) => i.fkUsuario === ctx.user.id)?.rol === "admin",
        integrantes: conversacion.integrantes.map((i) => ({
          id: i.fkUsuario,
          nombre:
            `${i.usuario.persona.nombre} ${i.usuario.persona.apellidoPaterno} ${i.usuario.persona.apellidoMaterno ?? ""}`.trim(),
          rol: i.rol,
        })),
        ultimoMensaje,
        ultimoMensajeCreadoEn: ultimo?.creadoEn.toISOString() ?? null,
        noLeidos,
      });
    }
    dtos.sort((a, b) => {
      const ka = a.ultimoMensajeCreadoEn ?? "";
      const kb = b.ultimoMensajeCreadoEn ?? "";
      return kb.localeCompare(ka);
    });
    return dtos;
  }),

  // Legacy MensajeListView: paginated timeline of an ACTIVE conversation the caller
  // belongs to, newest first.
  listarMensajes: protectedProcedure
    .input(
      z.object({
        fkConversacion: ID,
        limite: z.number().int().min(1).max(200).default(50),
        // Cursor pagination: creado_en (ISO) of the OLDEST message of the previous page.
        anteriorA: z.string().datetime().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await asegurarIntegrante(ctx.db, input.fkConversacion, ctx.user.id);
      const filas = await ctx.db.mensaje.findMany({
        where: {
          fkConversacion: input.fkConversacion,
          estado: true,
          ...(input.anteriorA ? { creadoEn: { lt: new Date(input.anteriorA) } } : {}),
        },
        include: inclMensaje,
        orderBy: { creadoEn: "desc" },
        take: input.limite,
      });
      return filas.map(aMensajeDto);
    }),

  // Legacy MensajeCreateSerializer: member of an active conversation; the author is
  // bound to the authenticated identity. One tx: mensaje insert + outbox +
  // sync_operacion(aplicada). WS notify AFTER commit (read-only notifier — the S3
  // PULL is the delivery path; the event only accelerates it).
  //
  // T17 (adjuntos): tipo "imagen" requires the ALREADY-UPLOADED archivoUrl (the
  // POST /upload/documentos bridge persisted the documento row first) and makes
  // contenido optional (legacy image-only parity). texto keeps contenido required.
  // T6 (gap-pass-9): "audio"|"video" ride the SAME lanes (online enviar with the
  // uploaded URL; the sync push schema never parses tipo/archivoUrl).
  enviar: protectedProcedure
    .input(
      z
        .object({
          fkConversacion: ID,
          contenido: CONTENIDO.optional(),
          tipo: TIPO_MENSAJE,
          archivoUrl: z.string().min(1).max(500).optional(),
          operationId: ID.optional(),
        })
        .refine((v) => v.tipo !== "texto" || (v.contenido?.length ?? 0) > 0, {
          message: "El contenido es obligatorio.",
        })
        .refine((v) => v.tipo === "texto" || typeof v.archivoUrl === "string", {
          message: "El mensaje requiere un archivo adjunto.",
        }),
    )
    .mutation(async ({ input, ctx }) => {
      await asegurarIntegrante(ctx.db, input.fkConversacion, ctx.user.id);
      const mensaje = await ejecutarOperacion<MensajeDto>(ctx.db, {
        actor: ctx.user.id,
        operationId: input.operationId,
        op: "enviar",
        docId: (r) => r.id,
        correr: async (tx) => {
          const creado = await tx.mensaje.create({
            data: {
              fkConversacion: input.fkConversacion,
              fkAutor: ctx.user.id,
              contenido: input.contenido,
              ...(input.tipo === "texto" ? {} : { tipo: input.tipo, archivoUrl: input.archivoUrl }),
            },
            include: inclMensaje,
          });
          await escribirCambios(tx, ctx.user.id, [
            { tablaOrigen: "mensaje", idFila: creado.id, operacion: "insert" },
          ]);
          return aMensajeDto(creado);
        },
        empaquetar: (r) => r as unknown as Prisma.InputJsonValue,
      });
      const destinatarios = await ctx.db.integrante.findMany({
        where: { fkConversacion: input.fkConversacion, fkUsuario: { not: ctx.user.id } },
        select: { fkUsuario: true },
      });
      ctx.notificador.publicar(
        destinatarios.map((d) => d.fkUsuario),
        {
          tipo: "mensaje_nuevo",
          conversacionId: input.fkConversacion,
          idMensaje: mensaje.id,
        },
      );
      return mensaje;
    }),

  // Legacy ConversacionLeerView PATCH: mark ALL non-own unread messages of the
  // conversation as leido (monotonic false→true). One outbox row per marked message
  // so the authors' PULLs see the read state. WS event "leido" goes to the AUTHORS.
  marcarLeido: protectedProcedure
    .input(z.object({ fkConversacion: ID, operationId: ID.optional() }))
    .mutation(async ({ input, ctx }) => {
      await asegurarIntegrante(ctx.db, input.fkConversacion, ctx.user.id);
      const docIdFijo = crypto.randomUUID();
      return ejecutarOperacion<{ marcados: number; ultimoId: string | null; autores: string[] }>(
        ctx.db,
        {
          actor: ctx.user.id,
          operationId: input.operationId,
          op: "marcarLeido",
          docId: () => docIdFijo,
          correr: async (tx) => {
            const noLeidos = await tx.mensaje.findMany({
              where: {
                fkConversacion: input.fkConversacion,
                leido: false,
                fkAutor: { not: ctx.user.id },
              },
              select: { id: true, fkAutor: true, creadoEn: true },
              orderBy: { creadoEn: "desc" },
            });
            if (noLeidos.length === 0) {
              return { marcados: 0, ultimoId: null, autores: [] };
            }
            await tx.mensaje.updateMany({
              where: {
                fkConversacion: input.fkConversacion,
                leido: false,
                fkAutor: { not: ctx.user.id },
              },
              data: { leido: true, version: { increment: 1 } },
            });
            await escribirCambios(
              tx,
              ctx.user.id,
              noLeidos.map((m) => ({
                tablaOrigen: "mensaje",
                idFila: m.id,
                operacion: "update" as const,
              })),
            );
            const autores = [
              ...new Set(noLeidos.map((m) => m.fkAutor).filter((a): a is string => a != null)),
            ];
            return { marcados: noLeidos.length, ultimoId: noLeidos[0]?.id ?? null, autores };
          },
          empaquetar: (r) => r as unknown as Prisma.InputJsonValue,
        },
      ).then((resultado) => {
        if (resultado.autores.length > 0) {
          ctx.notificador.publicar(resultado.autores, {
            tipo: "leido",
            conversacionId: input.fkConversacion,
            idMensaje: resultado.ultimoId,
          });
        }
        return { marcados: resultado.marcados, ultimoId: resultado.ultimoId };
      });
    }),

  // Legacy MensajeUpdateSerializer: author-only, 15-min window; sets editado=true.
  // No CAS (legacy parity — see module header); the S3 push path owns versioning.
  editar: protectedProcedure
    .input(z.object({ id: ID, contenido: CONTENIDO, operationId: ID.optional() }))
    .mutation(async ({ input, ctx }) => {
      const mensaje = await ejecutarOperacion<MensajeDto>(ctx.db, {
        actor: ctx.user.id,
        operationId: input.operationId,
        op: "editar",
        docId: () => input.id,
        correr: async (tx) => {
          const fila = await tx.mensaje.findUnique({
            where: { id: input.id },
            include: inclMensaje,
          });
          if (!fila || !fila.estado) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Mensaje no encontrado." });
          }
          if (fila.fkAutor !== ctx.user.id) {
            throw new RechazoChat("No puedes editar un mensaje que no te pertenece.");
          }
          if (Date.now() - fila.creadoEn.getTime() > VENTANA_EDICION_MS) {
            throw new RechazoChat(
              "Solo puedes editar mensajes con menos de 15 minutos de antigüedad.",
            );
          }
          await tx.mensaje.update({
            where: { id: input.id },
            data: { contenido: input.contenido, editado: true, version: { increment: 1 } },
          });
          await escribirCambios(tx, ctx.user.id, [
            { tablaOrigen: "mensaje", idFila: fila.id, operacion: "update" },
          ]);
          return aMensajeDto({ ...fila, contenido: input.contenido, editado: true });
        },
        empaquetar: (r) => r as unknown as Prisma.InputJsonValue,
      });
      const destinatarios = await ctx.db.integrante.findMany({
        where: { fkConversacion: mensaje.fkConversacion, fkUsuario: { not: ctx.user.id } },
        select: { fkUsuario: true },
      });
      ctx.notificador.publicar(
        destinatarios.map((d) => d.fkUsuario),
        { tipo: "mensaje_nuevo", conversacionId: mensaje.fkConversacion, idMensaje: mensaje.id },
      );
      return mensaje;
    }),

  // Legacy MensajeInactivarView: author-only soft-delete (estado=false) within the
  // 15-min window; membership required (legacy parity comment: a removed member must
  // not inactivate their old messages).
  eliminar: protectedProcedure
    .input(z.object({ id: ID, operationId: ID.optional() }))
    .mutation(async ({ input, ctx }) => {
      const mensaje = await ejecutarOperacion<MensajeDto>(ctx.db, {
        actor: ctx.user.id,
        operationId: input.operationId,
        op: "eliminar",
        docId: () => input.id,
        correr: async (tx) => {
          const fila = await tx.mensaje.findUnique({
            where: { id: input.id },
            include: {
              ...inclMensaje,
              conversacion: {
                include: {
                  integrantes: { where: { fkUsuario: ctx.user.id }, select: { id: true } },
                },
              },
            },
          });
          if (!fila || !fila.estado) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Mensaje no encontrado." });
          }
          if (fila.conversacion.integrantes.length === 0) {
            throw new RechazoChat("No eres miembro de esta conversación.");
          }
          if (fila.fkAutor !== ctx.user.id) {
            throw new RechazoChat("No puedes eliminar un mensaje que no te pertenece.");
          }
          if (Date.now() - fila.creadoEn.getTime() > VENTANA_EDICION_MS) {
            throw new RechazoChat("Solo se pueden eliminar mensajes de los últimos 15 minutos.");
          }
          await tx.mensaje.update({
            where: { id: input.id },
            data: { estado: false, version: { increment: 1 } },
          });
          await escribirCambios(tx, ctx.user.id, [
            { tablaOrigen: "mensaje", idFila: fila.id, operacion: "update" },
          ]);
          return aMensajeDto({ ...fila, estado: false });
        },
        empaquetar: (r) => r as unknown as Prisma.InputJsonValue,
      });
      const destinatarios = await ctx.db.integrante.findMany({
        where: { fkConversacion: mensaje.fkConversacion, fkUsuario: { not: ctx.user.id } },
        select: { fkUsuario: true },
      });
      ctx.notificador.publicar(
        destinatarios.map((d) => d.fkUsuario),
        { tipo: "mensaje_nuevo", conversacionId: mensaje.fkConversacion, idMensaje: mensaje.id },
      );
      return mensaje;
    }),

  // Legacy ConversacionPrivadaCreateView (views.py:240-300): IDEMPOTENT get-or-create
  // of a private 1:1 conversation (200 "ya existe" / 201 created — the frontend
  // createPrivateConversation treats both as success). Legacy parity kept: destination
  // must be an ACTIVE user ("El usuario no existe."), self-chat rejected ("No puedes
  // crear una conversación contigo mismo."), and the duplicate scan runs in a tx over
  // active PRIVATE conversations (tipo=false) holding integrantes rows for BOTH users
  // (the legacy SELECT FOR UPDATE row locks are replaced by one advisory xact lock —
  // two concurrent get-or-create calls must not create two conversations).
  //
  // WHO-WITH-WHOM (T17, task-approved — doc-deviation: legacy only required
  // IsAuthenticated, ANY user could open a 1:1 with ANY other): the commerce actors
  // are Agricultor/Vendedor, so Cliente/Vendedor/Agricultor may start a 1:1 only with
  // Agricultor or Vendedor; Admin may chat with anyone; NOBODY opens a 1:1 with a
  // Cliente except Admin (customers do not answer chats). Group/family conversations
  // are out of scope here (families already get theirs via M-9 integration).
  iniciarPrivado: protectedProcedure
    .input(z.object({ fkUsuario: ID }))
    .mutation(async ({ input, ctx }) => {
      if (input.fkUsuario === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No puedes crear una conversación contigo mismo.",
        });
      }
      const destino = await ctx.db.usuario.findUnique({
        where: { id: input.fkUsuario },
        select: { estado: true, rol: { select: { nombre: true } } },
      });
      if (!destino?.estado) {
        throw new TRPCError({ code: "NOT_FOUND", message: "El usuario no existe." });
      }
      const rolDestino = destino.rol.nombre;
      if (
        ctx.user.rol !== ROLE.ADMIN &&
        rolDestino !== ROLE.AGRICULTOR &&
        rolDestino !== ROLE.VENDEDOR
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No puedes iniciar un chat privado con este usuario.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns void, which
        // Prisma cannot deserialize (recolecciones slot-lock parity).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('chat_privado'))`;
        const candidata = await tx.conversacion.findFirst({
          where: {
            tipo: false,
            estado: true,
            // Legacy parity: BOTH present is enough (a private conversation a third
            // member was added to long ago still resolves to the same conversation).
            AND: [
              { integrantes: { some: { fkUsuario: ctx.user.id } } },
              { integrantes: { some: { fkUsuario: input.fkUsuario } } },
            ],
          },
          select: { id: true },
        });
        if (candidata) {
          return { idConversacion: candidata.id, creado: false };
        }
        const creada = await tx.conversacion.create({
          data: {
            tipo: false,
            integrantes: {
              create: [{ fkUsuario: ctx.user.id }, { fkUsuario: input.fkUsuario }],
            },
          },
          select: { id: true },
        });
        return { idConversacion: creada.id, creado: true };
      });
    }),

  // T6 §7.21: contact source for the group-creation picker. usuarios.list is
  // Admin-only, so a non-admin browses their CHAT GRAPH only: users sharing an
  // active conversation + members of the caller's active families (documented
  // cut — legacy allowed searching ANY user via /chat/usuarios/buscar/).
  listarContactos: protectedProcedure.query(async ({ ctx }) => {
    const [integrantesConversaciones, membresiasFamilia] = await Promise.all([
      ctx.db.integrante.findMany({
        where: { fkUsuario: ctx.user.id, conversacion: { estado: true } },
        select: {
          conversacion: {
            select: {
              integrantes: {
                select: {
                  fkUsuario: true,
                  usuario: {
                    select: {
                      id: true,
                      estado: true,
                      persona: {
                        select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true },
                      },
                      rol: { select: { nombre: true } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      ctx.db.familiaUsuario.findMany({
        where: { fkUsuario: ctx.user.id, estado: true },
        select: {
          familia: {
            select: {
              membresias: {
                where: { estado: true },
                select: {
                  usuario: {
                    select: {
                      id: true,
                      estado: true,
                      persona: {
                        select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true },
                      },
                      rol: { select: { nombre: true } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ]);
    const contactos = new Map<string, { id: string; nombre: string; rol: string }>();
    for (const u of [
      ...integrantesConversaciones.flatMap((f) => f.conversacion.integrantes.map((i) => i.usuario)),
      ...membresiasFamilia.flatMap((m) => m.familia.membresias.map((i) => i.usuario)),
    ]) {
      if (!u.estado || u.id === ctx.user.id || contactos.has(u.id)) continue;
      contactos.set(u.id, {
        id: u.id,
        nombre:
          `${u.persona.nombre} ${u.persona.apellidoPaterno} ${u.persona.apellidoMaterno ?? ""}`.trim(),
        rol: u.rol.nombre,
      });
    }
    return [...contactos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }),

  // Legacy ConversacionGrupalCreateView: ANY authenticated user creates a manual
  // group (no familia — legacy "No se puede vincular una conversación a una familia
  // manualmente."), members must EXIST and be active, at least one member besides
  // the creator ("Se requiere al menos un integrante adicional."), and the creator
  // rides with rol "admin" (legacy _get_or_reactivate_integrante(usuario_creador,
  // conv, rol="admin")). The creator inside fkIntegrantes is deduped away — no
  // double-membership (DB UNIQUE fk_usuario+fk_conversacion). Offline: groups are
  // ONLINE-ONLY (conversaciones no se replica — the list is tRPC-only).
  crearGrupo: protectedProcedure
    .input(
      z.object({
        nombre: z.string().trim().min(1, "El campo nombre es requerido.").max(100),
        fkIntegrantes: z.array(ID).max(100).default([]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const ids = [...new Set(input.fkIntegrantes)].filter((id) => id !== ctx.user.id);
      if (ids.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Se requiere al menos un integrante adicional.",
        });
      }
      await asegurarUsuariosActivos(ctx.db, ids);
      const creada = await ctx.db.conversacion.create({
        data: {
          tipo: true,
          nombre: input.nombre,
          integrantes: {
            create: [
              { fkUsuario: ctx.user.id, rol: "admin" },
              ...ids.map((fkUsuario) => ({ fkUsuario, rol: "miembro" })),
            ],
          },
        },
        select: { id: true },
      });
      avisarGrupo(ctx.notificador, ids, creada.id);
      return { idConversacion: creada.id };
    }),

  // Legacy ConversacionRenombrarView: creator-or-Admin only, manual groups only
  // (legacy "El nombre del grupo familiar se gestiona desde la familia.").
  renombrarConversacion: protectedProcedure
    .input(
      z.object({
        id: ID,
        nombre: z.string().trim().min(1, "El campo nombre es requerido.").max(100),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await asegurarAdminGrupo(ctx.db, input.id, ctx.user.id, ctx.user.rol);
      await ctx.db.conversacion.update({
        where: { id: input.id },
        data: { nombre: input.nombre },
      });
      const integrantes = await ctx.db.integrante.findMany({
        where: { fkConversacion: input.id },
        select: { fkUsuario: true },
      });
      avisarGrupo(
        ctx.notificador,
        integrantes.map((i) => i.fkUsuario),
        input.id,
      );
      return { id: input.id, nombre: input.nombre };
    }),

  // Legacy ConversacionAgregarIntegranteView, batched. Idempotent semantics: an
  // already-member id is SKIPPED (legacy single-add answered "El usuario ya es
  // miembro."; a batch re-add is a UI-retry surface, so skipping wins). Added users
  // get a WS "grupo" nudge so their listarConversaciones picks the conversation up.
  agregarIntegrantes: protectedProcedure
    .input(z.object({ id: ID, usuarios: z.array(ID).max(100) }))
    .mutation(async ({ input, ctx }) => {
      await asegurarAdminGrupo(ctx.db, input.id, ctx.user.id, ctx.user.rol);
      const ids = [...new Set(input.usuarios)];
      await asegurarUsuariosActivos(ctx.db, ids);
      const yaMiembros = new Set(
        (
          await ctx.db.integrante.findMany({
            where: { fkConversacion: input.id, fkUsuario: { in: ids } },
            select: { fkUsuario: true },
          })
        ).map((i) => i.fkUsuario),
      );
      const nuevos = ids.filter((id) => !yaMiembros.has(id));
      if (nuevos.length > 0) {
        await ctx.db.integrante.createMany({
          data: nuevos.map((fkUsuario) => ({
            fkConversacion: input.id,
            fkUsuario,
            rol: "miembro",
          })),
        });
        avisarGrupo(ctx.notificador, nuevos, input.id);
      }
      return { agregados: nuevos.length };
    }),

  // Legacy ConversacionIntegranteRemoveView, batched. v2 Integrante has NO estado —
  // removal deletes the row (reversible by re-insert; familias.prisma parity). Guard:
  // the creator (rol "admin") can NOT be removed — the group would be left with no
  // admin (documented cut of the legacy behavior, which allowed it).
  quitarIntegrante: protectedProcedure
    .input(z.object({ id: ID, usuarios: z.array(ID).max(100) }))
    .mutation(async ({ input, ctx }) => {
      await asegurarAdminGrupo(ctx.db, input.id, ctx.user.id, ctx.user.rol);
      const ids = [...new Set(input.usuarios)];
      const objetivo = await ctx.db.integrante.findMany({
        where: { fkConversacion: input.id, fkUsuario: { in: ids } },
        select: { id: true, fkUsuario: true, rol: true },
      });
      if (objetivo.some((o) => o.rol === "admin")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No puedes quitar al creador del grupo.",
        });
      }
      if (objetivo.length === 0) {
        return { removidos: 0 };
      }
      await ctx.db.integrante.deleteMany({
        where: { id: { in: objetivo.map((o) => o.id) } },
      });
      avisarGrupo(
        ctx.notificador,
        objetivo.map((o) => o.fkUsuario),
        input.id,
      );
      return { removidos: objetivo.length };
    }),

  // T17 (gap 20) + T6 (gap-pass-9): chat attachment upload metadata. BYTES ride the
  // multipart bridge POST /upload/documentos (same createCaller pattern as
  // /upload/imagenes — auth + state/fresh-role re-verified per call); this procedure
  // stays the authority for the validation chain and the `documento` row. IMAGES
  // (≤5 MiB, productos' asegurarFirmaImagen chain) + AUDIO/VIDEO (≤15 MiB,
  // lib/media-firma container signatures) — the mensaje.tipo CHECK already allows
  // audio|video. Any authenticated user may upload (legacy IsAuthenticated parity on
  // enviar-con-documento): the file is private-by-reference — only conversation
  // members ever receive its URL inside a mensaje.
  documentos: router({
    upload: protectedProcedure
      .input(
        z.object({
          fileName: z.string().min(1).max(255),
          mimeType: z.string().min(1).max(100),
          dataBase64: z.string().min(1),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        // Canonicalize the declared MIME (Bun's formData() parser normalizes
        // aliases: audio/wav → audio/x-wav, audio/mp4 → audio/x-m4a) — validation
        // accepts both spellings, the stored tipo_mime is canonical (/storage
        // serving maps by extension, not by this column).
        const mime = mimeCanonico(input.mimeType);
        let bytes: Uint8Array;
        let extension: string;
        if (mime in MIME_PERMITIDOS) {
          bytes = decodificarBase64(input.dataBase64);
          asegurarFirmaImagen(bytes, mime as MimePermitido);
          if (!extensionCoincide(input.fileName, mime as MimePermitido)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "La extensión del archivo no coincide con su tipo de contenido",
            });
          }
          extension = MIME_PERMITIDOS[mime as MimePermitido];
        } else if (esMimeMedia(mime)) {
          bytes = decodificarBase64Media(input.dataBase64);
          asegurarFirmaMedia(bytes, mime as MimeMedia);
          if (!extensionCoincideMedia(input.fileName, mime as MimeMedia)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "La extensión del archivo no coincide con su tipo de contenido",
            });
          }
          extension = MIME_MEDIA[mime as MimeMedia];
        } else {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Tipo de archivo no permitido" });
        }
        // Adapter write BEFORE the row (productos.imagenes.upload parity): on a row
        // failure the file is removed (best-effort) so no orphan is left behind.
        const guardado = await ctx.storage.save(bytes, extension, "documentos");
        try {
          const fila = await ctx.db.documento.create({
            data: {
              nombre: input.fileName,
              tipoMime: mime,
              tamanoBytes: BigInt(bytes.byteLength),
              storageKey: guardado.storageKey,
              url: guardado.url,
              fkAutor: ctx.user.id,
            },
          });
          return { id: fila.id, url: fila.url, storageKey: fila.storageKey };
        } catch (error) {
          await ctx.storage.remove(guardado.storageKey);
          throw error;
        }
      }),
  }),
});
