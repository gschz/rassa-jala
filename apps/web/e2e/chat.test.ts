import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN,
  AGRO,
  CLIENTE,
  DEV_PASSWORD,
  ensureServer,
  maxSeq,
  pgQuery,
  pgUna,
  pullHasta,
  pullUna,
  pushComo,
  sufijo,
  tokenDe,
  trpc,
  VENDEDOR,
  VENDEDOR2,
} from "./helpers";

const T = 240_000;

// P1-D Chat e2e (docs/roadmap.md §6 P1-D; docs/database.md §3.6 mensaje row + M-18,
// §6.2 S3 bidirectional; docs/synchronization.md §6/§8/§9 + the WS-notifier decision
// of 2026-11-20). Rules extracted from legacy/rassa_back/rassa/blueprints/chat —
// never copied:
// - Scoping: reads/sends require an active conversation + an integrantes row
//   (v2 uniform 403; legacy sent 400/404 — documented doc-deviation).
// - leido: monotonic per-message boolean (legacy bulk PATCH), server-owned in the
//   S3 push (stale versionAsumida → conflicto with the real state; replay → stored
//   verdict, PG unchanged).
// - 15-min window: CONFIRMED in legacy (settings.CHAT_EDIT_WINDOW_MINUTES=15) for
//   BOTH chat.editar and chat.eliminar, author-only.
// - WS notifier (Bun native): the event arrives at ANOTHER member's socket after a
//   push/send; unauthenticated upgrades are rejected.
// - Seed fixture: the family conversation (fixed id) has AGRO (admin) + VENDEDOR
//   (miembro) as integrantes — CLIENTE is NOT a member.

const CONVERSACION_FAMILIA = "b2c3d4e5-f607-4a81-9b2c-3d4e5f607a18";

type MensajeDto = {
  id: string;
  fkConversacion: string;
  fkAutor: string | null;
  autorNombre: string | null;
  contenido: string;
  leido: boolean;
  editado: boolean;
  creadoEn: string;
};

type MensajeDoc = {
  id: string;
  fkConversacion: string;
  fkAutor: string | null;
  autorNombre: string | null;
  contenido: string | null;
  leido: boolean;
  editado: boolean;
  estado: boolean;
  version: number;
  creadoEn: string;
  actualizadoEn: string;
  _deleted: boolean;
};

type ConversacionDto = {
  id: string;
  tipo: string;
  nombre: string;
  esFamilia: boolean;
  ultimoMensaje: string | null;
  noLeidos: number;
};

type PushResultado = {
  operationId: string;
  docId: string;
  veredicto: string;
  motivo?: string;
  estadoServidor?: unknown;
};

// The server push schema accepts the PARTIAL message doc (the lane's allowed fields);
// the client-side PushOperacion type is the full RxDB doc — same cast pattern as
// publicaciones-push.test.ts (`as never[]`).
const pushMensaje = (operaciones: unknown[], token: string): Promise<PushResultado[]> =>
  pushComo<MensajeDoc>("mensajes", operaciones as never[], token);

const countMensajes = async (): Promise<number> =>
  (await pgUna<{ n: number }>("select count(*)::int n from mensaje")).n;

/** Waits for ONE websocket event matching the predicate (bounded). */
function esperarEvento(
  ws: WebSocket,
  predicado: (evento: {
    tipo: string;
    conversacionId: string;
    idMensaje: string | null;
  }) => boolean,
  deadlineMs = 15_000,
): Promise<{ tipo: string; conversacionId: string; idMensaje: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`[WS TIMEOUT ${deadlineMs}ms] event not received`));
    }, deadlineMs);
    const onMessage = (event: MessageEvent): void => {
      try {
        const data = JSON.parse(String(event.data)) as {
          tipo: string;
          conversacionId: string;
          idMensaje: string | null;
        };
        if (predicado(data)) {
          clearTimeout(timer);
          ws.removeEventListener("message", onMessage);
          resolve(data);
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

/** Opens a WS socket (Bun native client) and resolves on open (bounded). */
function abrirSocket(url: string, deadlineMs = 10_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(
      () => reject(new Error(`[WS OPEN TIMEOUT ${deadlineMs}ms] ${url}`)),
      deadlineMs,
    );
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`[WS ERROR] ${url}`));
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new Error(`[WS CLOSED] ${url}`));
    });
  });
}

describe("chat e2e (p1-chat proofs)", () => {
  let agroToken = "";
  let vendedorToken = "";
  let clienteToken = "";
  let adminToken = "";
  let vendedor2Token = "";
  let agroId = "";
  let vendedorId = "";

  beforeAll(async () => {
    await ensureServer();
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    vendedorToken = await tokenDe("vendedor@rassa.local", DEV_PASSWORD);
    clienteToken = await tokenDe(CLIENTE, DEV_PASSWORD);
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
    vendedor2Token = await tokenDe(VENDEDOR2, DEV_PASSWORD);
    agroId = (await pgUna<{ id: string }>("select id from usuario where correo = $1", [AGRO])).id;
    vendedorId = (
      await pgUna<{ id: string }>("select id from usuario where correo = $1", [VENDEDOR])
    ).id;
  }, 90_000);

  test(
    "envio + entrega: two members of the SAME conversation, scoped PULL delivers; non-member never sees it",
    async () => {
      // Baseline checkpoint BEFORE the mutation (the outbox row of this message must
      // be > cp, else the pull never sees it).
      const cpVendedor = await maxSeq("mensaje");
      const contenido = `Hola familia ${sufijo()}`;
      const res = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        { fkConversacion: CONVERSACION_FAMILIA, contenido, operationId: crypto.randomUUID() },
        agroToken,
      );
      expect(res.ok).toBeTrue();
      const idMensaje = res.ok ? res.data.id : "";
      expect(idMensaje).not.toBe("");
      const entregados = await pullHasta<MensajeDoc>(
        "mensajes",
        cpVendedor,
        vendedorToken,
        (docs) => docs.some((d) => d.id === idMensaje && d.contenido === contenido),
      );
      const recibido = entregados.find((d) => d.id === idMensaje);
      expect(recibido?.fkAutor).toBe(agroId);
      expect(recibido?.leido).toBe(false);

      // A NON-member (Cliente) pulling from zero NEVER receives it (scoping §4.4).
      const vistosCliente = await pullHasta<MensajeDoc>(
        "mensajes",
        null,
        clienteToken,
        // one full page from zero is enough: our message must not be among them
        () => true,
      );
      expect(vistosCliente.some((d) => d.id === idMensaje)).toBe(false);
    },
    T,
  );

  test(
    "replay idempotente (chat.enviar): same operationId → same message, PG count unchanged",
    async () => {
      const operationId = crypto.randomUUID();
      const contenido = `Replay ${sufijo()}`;
      const primera = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        { fkConversacion: CONVERSACION_FAMILIA, contenido, operationId },
        vendedorToken,
      );
      expect(primera.ok).toBeTrue();
      const antes = await countMensajes();
      const replay = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        { fkConversacion: CONVERSACION_FAMILIA, contenido, operationId },
        vendedorToken,
      );
      expect(replay.ok).toBeTrue();
      if (primera.ok && replay.ok) expect(replay.data.id).toBe(primera.data.id);
      expect(await countMensajes()).toBe(antes);
    },
    T,
  );

  test(
    "cola offline: mensajes PUSH create → aplicada → PULL delivers to the other member; push replay stores the verdict",
    async () => {
      const cpAgro = await maxSeq("mensaje");
      const docId = crypto.randomUUID();
      const contenido = `Cola offline ${sufijo()}`;
      const op = {
        operationId: crypto.randomUUID(),
        docId,
        op: "create" as const,
        nuevoEstado: { fkConversacion: CONVERSACION_FAMILIA, contenido },
        versionAsumida: null,
      };
      const resultados = await pushMensaje([op], vendedorToken);
      expect(resultados[0]?.veredicto).toBe("aplicada");

      const entregados = await pullHasta<MensajeDoc>("mensajes", cpAgro, agroToken, (docs) =>
        docs.some((d) => d.id === docId),
      );
      expect(entregados.find((d) => d.id === docId)?.contenido).toBe(contenido);

      // Replay: the stored verdict comes back and PG counts stay unchanged.
      const antes = await countMensajes();
      const replay = await pushMensaje([op], vendedorToken);
      expect(replay[0]?.veredicto).toBe("aplicada");
      expect(await countMensajes()).toBe(antes);
    },
    T,
  );

  test(
    "orphan delete (C2): PUSH delete of a doc the server never saw → rechazada 'Mensaje no encontrado.' with a tombstone estadoServidor; replay keeps the stored verdict",
    async () => {
      const docId = crypto.randomUUID();
      const op = {
        operationId: crypto.randomUUID(),
        docId,
        op: "delete" as const,
        nuevoEstado: { fkConversacion: CONVERSACION_FAMILIA, contenido: "fantasma" },
        versionAsumida: null,
      };
      // The client-side local-only delete rides this push; the verdict + tombstone
      // settle through the server-wins conflictHandler (one rejected push, no loop).
      const resultados = await pushMensaje([op], vendedorToken);
      expect(resultados[0]?.veredicto).toBe("rechazada");
      expect(resultados[0]?.motivo).toBe("Mensaje no encontrado.");
      const tombstone = resultados[0]?.estadoServidor as { id: string; _deleted: boolean };
      expect(tombstone?.id).toBe(docId);
      expect(tombstone?._deleted).toBe(true);

      // Replay: the stored verdict comes back, PG unchanged (the orphan settles).
      const antes = await countMensajes();
      const replay = await pushMensaje([op], vendedorToken);
      expect(replay[0]?.veredicto).toBe("rechazada");
      expect(replay[0]?.motivo).toBe("Mensaje no encontrado.");
      expect(await countMensajes()).toBe(antes);
    },
    T,
  );

  test(
    "T3 (gap-pass-6): versionAsumida 0 (the local-draft payload the old poisoned client sent) is normalized to null SERVER-side — no 400, the op takes the null path and settles as the C2 verdict",
    async () => {
      const op0 = {
        operationId: crypto.randomUUID(),
        docId: crypto.randomUUID(),
        op: "delete" as const,
        nuevoEstado: { fkConversacion: CONVERSACION_FAMILIA, contenido: "borrador" },
        versionAsumida: 0,
      };
      // Old behavior: input parse 400 → the client retried forever (the sync loop).
      // New: the shared schema treats 0 as null ("no version assumed") so the verdict
      // settles in ONE push — same outcome as the fixed client's null payload.
      const resultados = await pushMensaje([op0], vendedorToken);
      expect(resultados[0]?.veredicto).toBe("rechazada");
      expect(resultados[0]?.motivo).toBe("Mensaje no encontrado.");
    },
    T,
  );

  test(
    "no integrante: send/read 403, PUSH create rechazada",
    async () => {
      const contenido = `Intruso ${sufijo()}`;
      const enviar = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        { fkConversacion: CONVERSACION_FAMILIA, contenido, operationId: crypto.randomUUID() },
        clienteToken,
      );
      expect(enviar.ok).toBeFalse();
      if (!enviar.ok) {
        expect(enviar.status).toBe(403);
        expect(enviar.errorMessage).toBe("No eres miembro de esta conversación.");
      }
      const listar = await trpc<MensajeDto[]>(
        "query",
        "chat.listarMensajes",
        { fkConversacion: CONVERSACION_FAMILIA },
        clienteToken,
      );
      expect(listar.ok).toBeFalse();
      if (!listar.ok) expect(listar.status).toBe(403);

      const resultados = await pushMensaje(
        [
          {
            operationId: crypto.randomUUID(),
            docId: crypto.randomUUID(),
            op: "create",
            nuevoEstado: { fkConversacion: CONVERSACION_FAMILIA, contenido },
            versionAsumida: null,
          },
        ],
        clienteToken,
      );
      expect(resultados[0]?.veredicto).toBe("rechazada");
      expect(resultados[0]?.motivo).toBe("No eres miembro de esta conversación.");
    },
    T,
  );

  test(
    "T4 lane protection: a FOREIGN identity pushing the owner's draft is rechazada in-wire and does NOT poison the owner's replay (the client modifier that keeps the foreign draft out of the lane is unit-pinned in push-ops.test.ts)",
    async () => {
      // The threat (shared browser RxDB): the owner's (vendedor's) offline draft
      // leaks into another identity's lane. The client owner-guard keeps it out
      // (unit-pinned); THIS pins the wire half: the foreign push (cliente, not a
      // member) is rejected with a persisted verdict + tombstone, and the owner's
      // later push of the SAME draft docId under its OWN operationId adjudicates
      // fresh — no replay poisoning, no ghost rows.
      const docId = crypto.randomUUID();
      const contenido = `Borrador ajeno ${sufijo()}`;
      const antes = await countMensajes();
      const opAjeno = {
        operationId: crypto.randomUUID(),
        docId,
        op: "create" as const,
        nuevoEstado: { fkConversacion: CONVERSACION_FAMILIA, contenido },
        versionAsumida: null,
      };
      const ajeno = await pushMensaje([opAjeno], clienteToken);
      expect(ajeno[0]?.veredicto).toBe("rechazada");
      expect(ajeno[0]?.motivo).toBe("No eres miembro de esta conversación.");
      const tombstone = ajeno[0]?.estadoServidor as { id: string; _deleted: boolean };
      expect(tombstone?.id).toBe(docId);
      expect(tombstone?._deleted).toBe(true);
      // No ghost row: the foreign rejection never materializes the message.
      expect(await countMensajes()).toBe(antes);

      // The OWNER pushes the same draft docId with its OWN operationId: a fresh
      // adjudication — the foreign verdict (persisted by operationId) does not
      // poison it. This is exactly the replay the client-side protection saves.
      const dueño = await pushMensaje(
        [
          {
            operationId: crypto.randomUUID(),
            docId,
            op: "create" as const,
            nuevoEstado: { fkConversacion: CONVERSACION_FAMILIA, contenido },
            versionAsumida: null,
          },
        ],
        vendedorToken,
      );
      expect(dueño[0]?.veredicto).toBe("aplicada");
      const fila = await pgUna<{ fkAutor: string; contenido: string }>(
        'select fk_autor as "fkAutor", contenido from mensaje where id = $1',
        [docId],
      );
      expect(fila.fkAutor).toBe(vendedorId);
      expect(fila.contenido).toBe(contenido);

      // The foreign operationId's verdict stays stored (idempotent replay, §7).
      const ops = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_operacion where id = $1 and veredicto = 'rechazada'",
        [opAjeno.operationId],
      );
      expect(ops.n).toBe(1);
    },
    T,
  );

  test(
    "leido versionado: monotonic mark aplica; stale version → conflicto with leido=true; replay stores the verdict",
    async () => {
      // The vendedor sends; the servidor row starts at version=1.
      const enviado = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        {
          fkConversacion: CONVERSACION_FAMILIA,
          contenido: `Leido ${sufijo()}`,
          operationId: crypto.randomUUID(),
        },
        vendedorToken,
      );
      expect(enviado.ok).toBeTrue();
      const idMensaje = enviado.ok ? enviado.data.id : "";
      const fila = await pgUna<{ version: number; fk_conversacion: string }>(
        "select version::int version, fk_conversacion from mensaje where id = $1",
        [idMensaje],
      );

      // The OTHER member marks it read (versionAsumida = 1) → aplicada.
      const aplicada = await pushMensaje(
        [
          {
            operationId: crypto.randomUUID(),
            docId: idMensaje,
            op: "update",
            nuevoEstado: { fkConversacion: CONVERSACION_FAMILIA, leido: true },
            versionAsumida: fila.version,
          },
        ],
        agroToken,
      );
      expect(aplicada[0]?.veredicto).toBe("aplicada");
      const trasLeer = await pgUna<{ version: number; leido: boolean }>(
        "select version::int version, leido from mensaje where id = $1",
        [idMensaje],
      );
      expect(trasLeer.leido).toBe(true);

      // A STALE push (versionAsumida = 1, now 2) asking leido=false → conflicto with
      // the real server state (monotonic: the server keeps leido=true).
      const stale = await pushMensaje(
        [
          {
            operationId: crypto.randomUUID(),
            docId: idMensaje,
            op: "update",
            nuevoEstado: { fkConversacion: CONVERSACION_FAMILIA, leido: false },
            versionAsumida: fila.version,
          },
        ],
        agroToken,
      );
      expect(stale[0]?.veredicto).toBe("conflicto");
      const estadoServidor = stale[0]?.estadoServidor as MensajeDoc | undefined;
      expect(estadoServidor?.leido).toBe(true);
      expect(estadoServidor?.version).toBe(trasLeer.version);

      // Replay the SAME stale operationId → the stored verdict, PG unchanged.
      const antes = await countMensajes();
      const replay = await pushMensaje(
        [
          {
            operationId: stale[0]?.operationId ?? "",
            docId: idMensaje,
            op: "update",
            nuevoEstado: { fkConversacion: CONVERSACION_FAMILIA, leido: false },
            versionAsumida: fila.version,
          },
        ],
        agroToken,
      );
      expect(replay[0]?.veredicto).toBe("conflicto");
      expect(await countMensajes()).toBe(antes);
    },
    T,
  );

  test(
    "ventana de edición (15 min, legacy): edit/delete OUTSIDE the window → 400 exact message; INSIDE the window both work",
    async () => {
      // Baseline BEFORE the delete (the tombstone pull must see its outbox row).
      const cpTombstone = await maxSeq("mensaje");
      // SQL fixture: a message 20 minutes old (author agro) — outside the window.
      const viejoId = crypto.randomUUID();
      await pgQuery(
        `insert into mensaje (id, fk_conversacion, fk_autor, contenido, leido, editado, estado, version, creado_en, actualizado_en)
         values ($1, $2, $3, $4, false, false, true, 1, now() - interval '20 minutes', now())`,
        [viejoId, CONVERSACION_FAMILIA, agroId, `Viejo ${sufijo()}`],
      );
      const editarViejo = await trpc<MensajeDto>(
        "mutation",
        "chat.editar",
        { id: viejoId, contenido: `Editado tarde ${sufijo()}`, operationId: crypto.randomUUID() },
        agroToken,
      );
      expect(editarViejo.ok).toBeFalse();
      if (!editarViejo.ok) {
        expect(editarViejo.status).toBe(400);
        expect(editarViejo.errorMessage).toBe(
          "Solo puedes editar mensajes con menos de 15 minutos de antigüedad.",
        );
      }
      const eliminarViejo = await trpc<MensajeDto>(
        "mutation",
        "chat.eliminar",
        { id: viejoId, operationId: crypto.randomUUID() },
        agroToken,
      );
      expect(eliminarViejo.ok).toBeFalse();
      if (!eliminarViejo.ok) {
        expect(eliminarViejo.status).toBe(400);
        expect(eliminarViejo.errorMessage).toBe(
          "Solo se pueden eliminar mensajes de los últimos 15 minutos.",
        );
      }

      // A foreign (non-author) edit is rejected even inside the window.
      const reciente = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        {
          fkConversacion: CONVERSACION_FAMILIA,
          contenido: `Reciente ${sufijo()}`,
          operationId: crypto.randomUUID(),
        },
        vendedorToken,
      );
      expect(reciente.ok).toBeTrue();
      const idReciente = reciente.ok ? reciente.data.id : "";
      const edicionAjena = await trpc<MensajeDto>(
        "mutation",
        "chat.editar",
        { id: idReciente, contenido: "no es mío", operationId: crypto.randomUUID() },
        agroToken,
      );
      expect(edicionAjena.ok).toBeFalse();
      if (!edicionAjena.ok) {
        expect(edicionAjena.errorMessage).toBe("No puedes editar un mensaje que no te pertenece.");
      }

      // Inside the window: the AUTHOR edits (editado=true) and deletes (soft).
      const editarOk = await trpc<MensajeDto>(
        "mutation",
        "chat.editar",
        {
          id: idReciente,
          contenido: `Editado a tiempo ${sufijo()}`,
          operationId: crypto.randomUUID(),
        },
        vendedorToken,
      );
      expect(editarOk.ok).toBeTrue();
      if (editarOk.ok) expect(editarOk.data.editado).toBe(true);
      const eliminarOk = await trpc<MensajeDto>(
        "mutation",
        "chat.eliminar",
        { id: idReciente, operationId: crypto.randomUUID() },
        vendedorToken,
      );
      expect(eliminarOk.ok).toBeTrue();
      const fila = await pgUna<{ estado: boolean }>("select estado from mensaje where id = $1", [
        idReciente,
      ]);
      expect(fila.estado).toBe(false);
      // The soft-delete propagates as a tombstone through the scoped PULL.
      await pullHasta<MensajeDoc>("mensajes", cpTombstone, agroToken, (docs) =>
        docs.some((d) => d.id === idReciente && d._deleted === true),
      );
    },
    T,
  );

  test(
    "WS notificador: the OTHER member's socket receives mensaje_nuevo after a send; leido event reaches the author; unauthenticated upgrade rejected",
    async () => {
      const socketVendedor = await abrirSocket(`ws://localhost:3010/ws?token=${vendedorToken}`);
      const socketAgro = await abrirSocket(`ws://localhost:3010/ws?token=${agroToken}`);

      // The server publishes synchronously INSIDE the mutation — the event can beat
      // the HTTP response round-trip, so the listeners are armed BEFORE the sends.
      const promesaNuevo = esperarEvento(
        socketVendedor,
        (e) => e.tipo === "mensaje_nuevo" && e.conversacionId === CONVERSACION_FAMILIA,
      );

      // 1. agro sends → the vendedor's socket hears mensaje_nuevo.
      const contenido = `WS ${sufijo()}`;
      const enviado = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        { fkConversacion: CONVERSACION_FAMILIA, contenido, operationId: crypto.randomUUID() },
        agroToken,
      );
      expect(enviado.ok).toBeTrue();
      const idMensaje = enviado.ok ? enviado.data.id : "";
      const evento = await promesaNuevo;
      expect(evento.idMensaje).toBe(idMensaje);

      // 2. the vendedor marks read → the AUTHOR's socket hears leido.
      const promesaLeido = esperarEvento(
        socketAgro,
        (e) => e.tipo === "leido" && e.idMensaje === idMensaje,
      );
      const leido = await trpc<{ marcados: number }>(
        "mutation",
        "chat.marcarLeido",
        { fkConversacion: CONVERSACION_FAMILIA, operationId: crypto.randomUUID() },
        vendedorToken,
      );
      expect(leido.ok).toBeTrue();
      const eventoLeido = await promesaLeido;
      expect(eventoLeido.conversacionId).toBe(CONVERSACION_FAMILIA);

      socketVendedor.close();
      socketAgro.close();

      // 3. Unauthenticated upgrade → 401 (the client sees a failed handshake).
      const rechazado = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket("ws://localhost:3010/ws");
        ws.addEventListener("open", () => resolve(false));
        ws.addEventListener("error", () => resolve(true));
        ws.addEventListener("close", () => resolve(true));
        setTimeout(() => resolve(false), 8_000);
      });
      expect(rechazado).toBe(true);
    },
    T,
  );

  test(
    "T2 (gap-pass-8) — fully-invisible-batch livelock: a pull with NO visible docs must NOT advance the checkpoint (RxDB cannot persist an empty batch's checkpoint — the stale server behavior returned documentos [] with the checkpoint advanced and the client re-pulled the same rows forever, so a user whose first visible outbox row sat behind OTHER users' messages never received anything)",
    async () => {
      // VENDEDOR2 (fixture user) has NO chat membership: every mensaje outbox row
      // is invisible to it, so its first pull pages the whole outbox and must come
      // back empty WITHOUT advancing the checkpoint.
      const desdeCero = await pullUna<MensajeDoc>("mensajes", null, vendedor2Token);
      expect(desdeCero.documentos.length).toBe(0);
      // The OLD bug returned checkpoint 2856 (the first invisible batch's cut) with
      // zero docs; the fix keeps the caller's checkpoint on an empty result.
      expect(desdeCero.checkpoint).toBe(0);

      // The owner's scenario must deliver: pulling from ZERO as a member pages past
      // the invisible prefix and RETURNS the visible docs with the advanced checkpoint.
      const entregado = await pullUna<MensajeDoc>("mensajes", null, vendedorToken);
      expect(entregado.documentos.length).toBeGreaterThan(0);
      expect(entregado.checkpoint ?? 0).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "fallback polling path: the server-fetched list (refetchInterval data source) carries the conversation + unread count; ws-client without token stays disconnected",
    async () => {
      const contenido = `Polling ${sufijo()}`;
      const enviado = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        { fkConversacion: CONVERSACION_FAMILIA, contenido, operationId: crypto.randomUUID() },
        agroToken,
      );
      expect(enviado.ok).toBeTrue();
      const listado = await trpc<ConversacionDto[]>(
        "query",
        "chat.listarConversaciones",
        null,
        vendedorToken,
      );
      expect(listado.ok).toBeTrue();
      if (listado.ok) {
        const conv = listado.data.find((c) => c.id === CONVERSACION_FAMILIA);
        expect(conv?.tipo).toBe("grupal");
        expect(conv?.esFamilia).toBe(true);
        expect(conv?.noLeidos).toBeGreaterThan(0);
        expect(conv?.ultimoMensaje).toBe(contenido);
      }
      // The Admin is NOT a member (legacy parity: no admin bypass in chat).
      const adminList = await trpc<ConversacionDto[]>(
        "query",
        "chat.listarConversaciones",
        null,
        adminToken,
      );
      if (adminList.ok) {
        expect(adminList.data.some((c) => c.id === CONVERSACION_FAMILIA)).toBe(false);
      }
    },
    T,
  );
});
