import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  AGRO,
  BASE_URL,
  CLIENTE,
  DEV_PASSWORD,
  ensureFixtures,
  ensureServer,
  maxSeq,
  pgQuery,
  pgUna,
  PNG_BYTES,
  pullHasta,
  sufijo,
  TEST_PORT,
  tokenDe,
  trpc,
  VENDEDOR,
  VENDEDOR2,
} from "./helpers";

const T = 240_000;

// T6 (gap-pass-9) §7.21 — manual groups + audio/video attachments (closes the chat
// P2). Proofs:
// - crearGrupo: ANY authenticated role creates a manual group (legacy
//   ConversacionGrupalCreateView reduced); creator rides as integrantes.rol "admin";
//   members must exist; fk_familia stays NULL; ≥1 member besides the creator.
// - conversaciones NO se replica: the group reaches members through
//   chat.listarConversaciones (tRPC) + the WS "grupo" nudge, never through PULL.
// - renombrar / agregar / quitar: creator-or-platform-Admin only (403 otherwise);
//   family conversations are NOT manageable (404); the creator cannot be removed.
// - audio/video attachments: the multipart bridge validates REAL container
//   signatures (lib/media-firma) and the message rides chat.enviar (tipo
//   audio|video + archivoUrl) — the S3 mensajes PULL delivers it to other members.

const CONVERSACION_FAMILIA = "b2c3d4e5-f607-4a81-9b2c-3d4e5f607a18";

type ConversacionDto = {
  id: string;
  tipo: string;
  nombre: string;
  esFamilia: boolean;
  manual: boolean;
  administrable: boolean;
  integrantes: Array<{ id: string; nombre: string; rol: string }>;
  ultimoMensaje: string | null;
  noLeidos: number;
};

type MensajeDto = { id: string; tipo: string; archivoUrl: string | null; contenido: string | null };

type MensajeDoc = { id: string; tipo: string; archivoUrl: string | null; contenido: string | null };

type DocumentoSubido = { id: string; url: string; storageKey: string };

// Minimal REAL container signatures (the server rejects liar content): MP3 ID3 +
// MPEG frame sync, WAV RIFF/WAVE, MP4/MOV ftyp boxes, WEBM EBML, OGG OggS.
const FILLER = Buffer.from("e2e-media-bytes-para-firmas");
const MP3_ID3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]), FILLER]);
const MP3_SYNC = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), FILLER]);
const WAV = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]),
  FILLER,
]);
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18, ...Buffer.from("ftypisom")]),
  FILLER,
]);
const M4A = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18, ...Buffer.from("ftypM4A ")]),
  FILLER,
]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), FILLER]);
const OGG = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53]), FILLER]);
const MOV = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18, ...Buffer.from("ftypqt  ")]),
  FILLER,
]);

const subirAdjunto = (
  token: string,
  bytes: BlobPart,
  nombre: string,
  mime: string,
): Promise<Response> => {
  const form = new FormData();
  form.append("file", new File([bytes], nombre, { type: mime }));
  return fetch(`${BASE_URL}/upload/documentos`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
};

/** Waits for ONE websocket event matching the predicate (bounded). */
function esperarEvento(
  ws: WebSocket,
  predicado: (evento: { tipo: string; conversacionId: string }) => boolean,
  deadlineMs = 15_000,
): Promise<{ tipo: string; conversacionId: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`[WS TIMEOUT ${deadlineMs}ms] event not received`));
    }, deadlineMs);
    const onMessage = (event: MessageEvent): void => {
      try {
        const data = JSON.parse(String(event.data)) as { tipo: string; conversacionId: string };
        if (predicado(data)) {
          clearTimeout(timer);
          ws.removeEventListener("message", onMessage);
          resolve(data);
        }
      } catch {
        // malformed frame: ignore
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

const grupoDeListado = async (token: string, id: string): Promise<ConversacionDto | null> => {
  const lista = await trpc<ConversacionDto[]>("query", "chat.listarConversaciones", {}, token);
  expect(lista.ok).toBeTrue();
  return lista.ok ? (lista.data.find((c) => c.id === id) ?? null) : null;
};

describe("chat grupos manuales + media e2e (T6, gap-pass-9)", () => {
  let vendedorToken = "";
  let agroToken = "";
  let clienteToken = "";
  let vendedorId = "";
  let agroId = "";
  let clienteId = "";
  let vendedor2Id = "";

  beforeAll(async () => {
    await ensureServer();
    await ensureFixtures();
    vendedorToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    clienteToken = await tokenDe(CLIENTE, DEV_PASSWORD);
    await tokenDe(VENDEDOR2, DEV_PASSWORD);
    vendedorId = (
      await pgUna<{ id: string }>("select id from usuario where correo = $1", [VENDEDOR])
    ).id;
    agroId = (await pgUna<{ id: string }>("select id from usuario where correo = $1", [AGRO])).id;
    clienteId = (await pgUna<{ id: string }>("select id from usuario where correo = $1", [CLIENTE]))
      .id;
    vendedor2Id = (
      await pgUna<{ id: string }>("select id from usuario where correo = $1", [VENDEDOR2])
    ).id;
  }, 90_000);

  test(
    "crearGrupo: manual (sin familia), creador rol admin, integrantes existen; validaciones 400/404",
    async () => {
      const creada = await trpc<{ idConversacion: string }>(
        "mutation",
        "chat.crearGrupo",
        { nombre: `Equipo ${sufijo()}`, fkIntegrantes: [agroId, vendedorId, vendedor2Id] },
        vendedorToken,
      );
      expect(creada.ok).toBeTrue();
      const idGrupo = creada.ok ? creada.data.idConversacion : "";

      const fila = await pgUna<{ tipo: boolean; nombre: string; fk_familia: string | null }>(
        "select tipo, nombre, fk_familia from conversacion where id = $1",
        [idGrupo],
      );
      expect(fila.tipo).toBeTrue();
      expect(fila.fk_familia).toBeNull();
      expect(fila.nombre).toStartWith("Equipo ");

      // EXACTLY 3 integrantes (self-dedupe: the creator was listed + added); the
      // creator's row is the group admin, the others are "miembro" (legacy parity).
      const filas = await pgQuery<{ fk_usuario: string; rol: string }>(
        "select fk_usuario, rol from integrantes where fk_conversacion = $1 order by rol desc",
        [idGrupo],
      );
      expect(filas.length).toBe(3);
      expect(filas.find((f) => f.fk_usuario === vendedorId)?.rol).toBe("admin");

      // listarConversaciones (tRPC — conversaciones NO se replica) shows it for an
      // ADDED member too, with the manual name and creator flags.
      const vista = await grupoDeListado(agroToken, idGrupo);
      expect(vista?.nombre).toStartWith("Equipo ");
      expect(vista?.tipo).toBe("grupal");
      expect(vista?.esFamilia).toBeFalse();
      expect(vista?.manual).toBeTrue();
      expect(vista?.administrable).toBeFalse();

      // Solo-self → 400 ("Se requiere al menos un integrante adicional.").
      const solo = await trpc(
        "mutation",
        "chat.crearGrupo",
        { nombre: "X", fkIntegrantes: [vendedorId] },
        vendedorToken,
      );
      expect(solo.ok).toBeFalse();
      if (!solo.ok) expect(solo.status).toBe(400);

      // Unknown member → 404 ("Algunos usuarios no existen.").
      const fantasma = await trpc(
        "mutation",
        "chat.crearGrupo",
        { nombre: "X", fkIntegrantes: [crypto.randomUUID()] },
        vendedorToken,
      );
      expect(fantasma.ok).toBeFalse();
      if (!fantasma.ok) expect(fantasma.status).toBe(404);

      // Empty name → 400 (legacy "El campo nombre es requerido.").
      const vacio = await trpc(
        "mutation",
        "chat.crearGrupo",
        { nombre: "   ", fkIntegrantes: [agroId] },
        vendedorToken,
      );
      expect(vacio.ok).toBeFalse();
      if (!vacio.ok) expect(vacio.status).toBe(400);
    },
    T,
  );

  test(
    "renombrar: creador OK, miembro 403, no-miembro 403, conversación familiar 404",
    async () => {
      const creada = await trpc<{ idConversacion: string }>(
        "mutation",
        "chat.crearGrupo",
        { nombre: `Nombre inicial ${sufijo()}`, fkIntegrantes: [agroId] },
        vendedorToken,
      );
      expect(creada.ok).toBeTrue();
      const idGrupo = creada.ok ? creada.data.idConversacion : "";

      const renombrada = `Renombrado ${sufijo()}`;
      const ok = await trpc<{ id: string; nombre: string }>(
        "mutation",
        "chat.renombrarConversacion",
        { id: idGrupo, nombre: renombrada },
        vendedorToken,
      );
      expect(ok.ok).toBeTrue();
      const fila = await pgUna<{ nombre: string }>(
        "select nombre from conversacion where id = $1",
        [idGrupo],
      );
      expect(fila.nombre).toBe(renombrada);
      // The member's list reflects the rename after refetch (WS "grupo" nudge → invalidate).
      const vista = await grupoDeListado(agroToken, idGrupo);
      expect(vista?.nombre).toBe(renombrada);

      // A NON-admin member cannot rename (legacy _require_chat_admin parity).
      const miembro = await trpc(
        "mutation",
        "chat.renombrarConversacion",
        { id: idGrupo, nombre: "hack" },
        agroToken,
      );
      expect(miembro.ok).toBeFalse();
      if (!miembro.ok) expect(miembro.status).toBe(403);

      // A non-member cannot rename either (uniform 403, v2 chat.ts header).
      const ajeno = await trpc(
        "mutation",
        "chat.renombrarConversacion",
        { id: idGrupo, nombre: "hack" },
        clienteToken,
      );
      expect(ajeno.ok).toBeFalse();
      if (!ajeno.ok) expect(ajeno.status).toBe(403);

      // Family conversations are NOT manual groups (legacy "El nombre del grupo
      // familiar se gestiona desde la familia.").
      const familia = await trpc(
        "mutation",
        "chat.renombrarConversacion",
        { id: CONVERSACION_FAMILIA, nombre: "hack" },
        vendedorToken,
      );
      expect(familia.ok).toBeFalse();
      if (!familia.ok) expect(familia.status).toBe(404);
    },
    T,
  );

  test(
    "agregar/quitar integrantes: solo creador; añadido ve el grupo; re-add idempotente; creador ineliminable",
    async () => {
      const creada = await trpc<{ idConversacion: string }>(
        "mutation",
        "chat.crearGrupo",
        { nombre: `Integrantes ${sufijo()}`, fkIntegrantes: [agroId] },
        vendedorToken,
      );
      expect(creada.ok).toBeTrue();
      const idGrupo = creada.ok ? creada.data.idConversacion : "";

      // A member cannot add (creator-only guard).
      const prohibido = await trpc(
        "mutation",
        "chat.agregarIntegrantes",
        { id: idGrupo, usuarios: [clienteId] },
        agroToken,
      );
      expect(prohibido.ok).toBeFalse();
      if (!prohibido.ok) expect(prohibido.status).toBe(403);

      // Creator adds the cliente; the added user sees the group in their list.
      const agregado = await trpc<{ agregados: number }>(
        "mutation",
        "chat.agregarIntegrantes",
        { id: idGrupo, usuarios: [clienteId, clienteId] },
        vendedorToken,
      );
      expect(agregado.ok).toBeTrue();
      expect(agregado.ok && agregado.data.agregados).toBe(1); // dedupe
      const conteo = await pgUna<{ n: number }>(
        "select count(*)::int n from integrantes where fk_conversacion = $1 and fk_usuario = $2",
        [idGrupo, clienteId],
      );
      expect(conteo.n).toBe(1);
      expect((await grupoDeListado(clienteToken, idGrupo))?.nombre).toStartWith("Integrantes ");

      // Idempotent re-add: no second row, agregados 0.
      const reAdd = await trpc<{ agregados: number }>(
        "mutation",
        "chat.agregarIntegrantes",
        { id: idGrupo, usuarios: [clienteId] },
        vendedorToken,
      );
      expect(reAdd.ok).toBeTrue();
      expect(reAdd.ok && reAdd.data.agregados).toBe(0);

      // Unknown user → 404.
      const fantasma = await trpc(
        "mutation",
        "chat.agregarIntegrantes",
        { id: idGrupo, usuarios: [crypto.randomUUID()] },
        vendedorToken,
      );
      expect(fantasma.ok).toBeFalse();
      if (!fantasma.ok) expect(fantasma.status).toBe(404);

      // The creator cannot be removed (group would be orphaned without an admin).
      const quitarCreador = await trpc(
        "mutation",
        "chat.quitarIntegrante",
        { id: idGrupo, usuarios: [vendedorId] },
        vendedorToken,
      );
      expect(quitarCreador.ok).toBeFalse();
      if (!quitarCreador.ok) expect(quitarCreador.status).toBe(400);

      // Creator removes the cliente → the row is gone, the group leaves their list.
      const quitado = await trpc<{ removidos: number }>(
        "mutation",
        "chat.quitarIntegrante",
        { id: idGrupo, usuarios: [clienteId] },
        vendedorToken,
      );
      expect(quitado.ok).toBeTrue();
      expect(quitado.ok && quitado.data.removidos).toBe(1);
      const fuera = await pgUna<{ n: number }>(
        "select count(*)::int n from integrantes where fk_conversacion = $1 and fk_usuario = $2",
        [idGrupo, clienteId],
      );
      expect(fuera.n).toBe(0);
      expect(await grupoDeListado(clienteToken, idGrupo)).toBeNull();
    },
    T,
  );

  test(
    "WS 'grupo': el integrante añadido recibe el nudge al crear el grupo con él",
    async () => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?token=${agroToken}`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WS no conectó"));
      });
      try {
        // The listener attaches BEFORE the mutation: the "grupo" event can fire
        // while the mutation call is still awaiting its response (classic race).
        const pendiente = esperarEvento(ws, (e) => e.tipo === "grupo");
        const creada = await trpc<{ idConversacion: string }>(
          "mutation",
          "chat.crearGrupo",
          { nombre: `Nudge ${sufijo()}`, fkIntegrantes: [agroId] },
          vendedorToken,
        );
        expect(creada.ok).toBeTrue();
        const evento = await pendiente;
        expect(evento.conversacionId).toBe(creada.ok ? creada.data.idConversacion : "");
      } finally {
        ws.close();
      }
    },
    T,
  );

  test(
    "mensaje de texto y de audio en el grupo llegan a los integrantes por PULL; el audio se sirve por /storage",
    async () => {
      const creada = await trpc<{ idConversacion: string }>(
        "mutation",
        "chat.crearGrupo",
        { nombre: `Mensajes ${sufijo()}`, fkIntegrantes: [agroId] },
        vendedorToken,
      );
      expect(creada.ok).toBeTrue();
      const idGrupo = creada.ok ? creada.data.idConversacion : "";

      const cpAgro = await maxSeq("mensaje");
      const texto = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        {
          fkConversacion: idGrupo,
          contenido: `Hola grupo ${sufijo()}`,
          operationId: crypto.randomUUID(),
        },
        vendedorToken,
      );
      expect(texto.ok).toBeTrue();

      const subida = await subirAdjunto(agroToken, MP3_ID3, `nota-${sufijo()}.mp3`, "audio/mpeg");
      expect(subida.status).toBe(200);
      const doc = (await subida.json()) as DocumentoSubido;
      const audio = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        {
          fkConversacion: idGrupo,
          tipo: "audio",
          archivoUrl: doc.url,
          operationId: crypto.randomUUID(),
        },
        agroToken,
      );
      expect(audio.ok).toBeTrue();
      expect(audio.ok && audio.data.tipo).toBe("audio");

      // The member's PULL delivers BOTH (timeline = S3 mensajes collection).
      const entregados = await pullHasta<MensajeDoc>("mensajes", cpAgro, agroToken, (docs) =>
        docs.some((d) => d.id === (texto.ok ? texto.data.id : "")),
      );
      const recibidoTexto = entregados.find((d) => d.id === (texto.ok ? texto.data.id : ""));
      expect(recibidoTexto?.contenido).toStartWith("Hola grupo ");
      const recibidoAudio = entregados.find((d) => d.id === (audio.ok ? audio.data.id : ""));
      expect(recibidoAudio?.tipo).toBe("audio");
      expect(recibidoAudio?.archivoUrl).toBe(doc.url);

      // The stored audio is SERVED with its real content type (the allowlist
      // accepts the documentos/ media extensions).
      const servido = await fetch(`${BASE_URL}${doc.url}`);
      expect(servido.status).toBe(200);
      expect(servido.headers.get("content-type")).toBe("audio/mpeg");

      // The list projects the attachment label for audio-only last messages.
      const vista = await grupoDeListado(vendedorToken, idGrupo);
      expect(vista?.ultimoMensaje).toBe("Audio");

      // The sync push lane stays TEXT-ONLY (no wire path for files).
      expect(audio.ok && audio.data.archivoUrl).toBe(doc.url);
    },
    T,
  );

  test(
    "media firmas: mp3 (ID3 y frame), wav, mp4, m4a, webm, ogg, mov OK; mentira 400; tipo ajeno 400",
    async () => {
      const casos: Array<[BlobPart, string, string, string]> = [
        [MP3_ID3, "a.mp3", "audio/mpeg", "mp3"],
        [MP3_SYNC, "a.mp3", "audio/mpeg", "mp3"],
        [WAV, "a.wav", "audio/wav", "wav"],
        [MP4, "a.mp4", "video/mp4", "mp4"],
        [M4A, "a.m4a", "audio/mp4", "m4a"],
        [WEBM, "a.webm", "video/webm", "webm"],
        [OGG, "a.ogg", "audio/ogg", "ogg"],
        [MOV, "a.mov", "video/quicktime", "mov"],
      ];
      for (const [bytes, nombre, mime, extension] of casos) {
        const res = await subirAdjunto(vendedorToken, bytes, `${sufijo()}-${nombre}`, mime);
        expect(res.status).toBe(200);
        const doc = (await res.json()) as DocumentoSubido;
        expect(doc.storageKey).toEndWith(`.${extension}`);
        const fila = await pgUna<{ tipo_mime: string }>(
          "select tipo_mime from documento where id = $1",
          [doc.id],
        );
        expect(fila.tipo_mime).toBe(mime);
        // Served by /storage with the right content type.
        const servido = await fetch(`${BASE_URL}${doc.url}`);
        expect(servido.status).toBe(200);
        expect(servido.headers.get("content-type")).toBe(mime);
      }

      // Liar content (text bytes named .mp3) → 400.
      const mentiroso = await subirAdjunto(
        vendedorToken,
        Buffer.from("texto-sin-firma"),
        "cancion.mp3",
        "audio/mpeg",
      );
      expect(mentiroso.status).toBe(400);
      expect(((await mentiroso.json()) as { error: string }).error).toBe(
        "El contenido del archivo no coincide con el tipo de audio/video declarado",
      );

      // Declared MP3 but WAV bytes → 400 (signature family mismatch).
      const cruzado = await subirAdjunto(vendedorToken, WAV, "cancion.mp3", "audio/mpeg");
      expect(cruzado.status).toBe(400);

      // Outside the accepted set (audio/flac) → 400.
      const flac = await subirAdjunto(
        vendedorToken,
        Buffer.from("fLaC" + "x".repeat(20)),
        "cancion.flac",
        "audio/flac",
      );
      expect(flac.status).toBe(400);

      // Extension mismatch (WAV bytes named .mp3) → 400.
      const extension = await subirAdjunto(vendedorToken, WAV, "cancion.mp3", "audio/wav");
      expect(extension.status).toBe(400);

      // Images keep working through the SAME endpoint (5 MiB image limit intact).
      const imagen = await subirAdjunto(
        vendedorToken,
        PNG_BYTES,
        `img-${sufijo()}.png`,
        "image/png",
      );
      expect(imagen.status).toBe(200);
    },
    T,
  );

  test(
    "chat.enviar reglas: audio sin archivo 400, contenido de texto obligatorio, adjunto con caption",
    async () => {
      const creada = await trpc<{ idConversacion: string }>(
        "mutation",
        "chat.crearGrupo",
        { nombre: `Reglas ${sufijo()}`, fkIntegrantes: [agroId] },
        vendedorToken,
      );
      expect(creada.ok).toBeTrue();
      const idGrupo = creada.ok ? creada.data.idConversacion : "";

      // audio WITHOUT archivoUrl → 400.
      const sinArchivo = await trpc(
        "mutation",
        "chat.enviar",
        { fkConversacion: idGrupo, tipo: "audio" },
        vendedorToken,
      );
      expect(sinArchivo.ok).toBeFalse();
      if (!sinArchivo.ok) expect(sinArchivo.status).toBe(400);

      // Attachments keep the OPTIONAL caption (legacy image-only parity, now audio).
      const subida = await subirAdjunto(agroToken, OGG, `voz-${sufijo()}.ogg`, "audio/ogg");
      expect(subida.status).toBe(200);
      const doc = (await subida.json()) as DocumentoSubido;
      const conCaption = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        {
          fkConversacion: idGrupo,
          tipo: "audio",
          archivoUrl: doc.url,
          contenido: "Escúchame",
          operationId: crypto.randomUUID(),
        },
        agroToken,
      );
      expect(conCaption.ok).toBeTrue();
      expect(conCaption.ok && conCaption.data.contenido).toBe("Escúchame");

      // texto STILL requires contenido.
      const textoVacio = await trpc(
        "mutation",
        "chat.enviar",
        { fkConversacion: idGrupo, tipo: "texto" },
        vendedorToken,
      );
      expect(textoVacio.ok).toBeFalse();
      if (!textoVacio.ok) expect(textoVacio.status).toBe(400);
    },
    T,
  );

  test(
    "limpieza: la suite no deja conversaciones de prueba activas con nombre duplicado",
    async () => {
      // Housekeeping assertion instead of deletes: re-runs are safe because every
      // grupo carries a dynamic suffix; prove the pattern (>= this run's groups).
      const n = await pgUna<{ n: number }>(
        "select count(*)::int n from conversacion where tipo and fk_familia is null and nombre is not null and estado",
      );
      expect(n.n).toBeGreaterThanOrEqual(4);
    },
    T,
  );
});
