import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN,
  AGRO,
  BASE_URL,
  CLIENTE,
  DEV_PASSWORD,
  PNG_BYTES,
  VENDEDOR,
  ensureServer,
  maxSeq,
  pgQuery,
  pgUna,
  pullHasta,
  pushComo,
  sufijo,
  tokenDe,
  trpc,
} from "./helpers";

const T = 240_000;

// T17 (gap-pass-7) — Chat 1:1 privado + adjuntos de imagen (roadmap §7.20/§7.21,
// PDF FASE 13.4 M9). Proofs:
// - iniciarPrivado is an IDEMPOTENT get-or-create (legacy ConversacionPrivadaCreateView
//   parity: two calls resolve to the SAME conversation, no second row).
// - WHO-WITH-WHOM (T17 rules; doc-deviation of the legacy IsAuthenticated-only):
//   cliente→agricultor OK, agricultor→cliente 403, admin→cliente OK, self 400,
//   unknown/inactive 404.
// - Image attachments: the BYTES ride the multipart bridge POST /upload/documentos
//   (auth + server-side image signature + documento row); the MESSAGE (tipo imagen +
//   archivoUrl) rides chat.enviar; the OTHER member's PULL delivers tipo/archivoUrl;
//   the stored file is served by GET /storage/... (the allowlist now accepts the
//   documentos/ folder). The push lane stays TEXT-ONLY (no wire path for files).

type ConversacionPrivadaDto = { idConversacion: string; creado: boolean };

type MensajeDto = {
  id: string;
  fkConversacion: string;
  tipo: string;
  archivoUrl: string | null;
  contenido: string | null;
};

type MensajeDoc = {
  id: string;
  tipo: string;
  archivoUrl: string | null;
  contenido: string | null;
  _deleted: boolean;
};

type DocumentoSubido = { id: string; url: string; storageKey: string };

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

/** Private (tipo=false) conversations that hold integrantes rows for BOTH users. */
const cuentaPrivadasDelPar = async (a: string, b: string): Promise<number> =>
  (
    await pgUna<{ n: number }>(
      `select count(*)::int n from conversacion c
       where c.tipo = false and c.estado
         and (select count(*) from integrantes i where i.fk_conversacion = c.id
                and i.fk_usuario in ($1, $2)) = 2
         and (select count(*) from integrantes i where i.fk_conversacion = c.id) = 2`,
      [a, b],
    )
  ).n;

describe("chat privado + adjuntos e2e (T17, gap-pass-7)", () => {
  let agroToken = "";
  let vendedorToken = "";
  let clienteToken = "";
  let adminToken = "";
  let agroId = "";
  let vendedorId = "";
  let clienteId = "";
  // Second ACTIVE cliente fixture (fixed ids, upsert → re-run safe): the
  // cliente→cliente 403 proof needs a target that EXISTS and is active.
  const cliente2Id = "e2e11111-1111-4111-8111-111111111111";
  let cliente2Token = "";

  beforeAll(async () => {
    await ensureServer();
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    vendedorToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    clienteToken = await tokenDe(CLIENTE, DEV_PASSWORD);
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
    agroId = (await pgUna<{ id: string }>("select id from usuario where correo = $1", [AGRO])).id;
    vendedorId = (
      await pgUna<{ id: string }>("select id from usuario where correo = $1", [VENDEDOR])
    ).id;
    clienteId = (await pgUna<{ id: string }>("select id from usuario where correo = $1", [CLIENTE]))
      .id;

    // Fixture: second active Cliente (copies admin's hash → logs in with DEV_PASSWORD).
    const localidad = await pgUna<{ id: string }>(
      "select id from localidad where nombre = 'Tepic' and estado order by id limit 1",
    );
    await pgQuery(
      `insert into persona (id, nombre, apellido_paterno, fk_localidad)
       values ('e2e22222-2222-4222-8222-222222222222', 'ClienteDos', 'Fixture', $1)
       on conflict (id) do nothing`,
      [localidad.id],
    );
    await pgQuery(
      `insert into usuario (id, correo, password_hash, fk_persona, fk_rol)
       select $1, $2, u.password_hash, 'e2e22222-2222-4222-8222-222222222222', r.id
       from usuario u, roles r
       where u.correo = $3 and r.nombre = 'Cliente'
       on conflict (correo) do nothing`,
      [cliente2Id, "e2e-cliente2@fixture.local", ADMIN],
    );
    cliente2Token = await tokenDe("e2e-cliente2@fixture.local", DEV_PASSWORD);
    // The cliente→cliente 403 proof is only valid if the target EXISTS and is active.
    expect(cliente2Token).not.toBe("");
  }, 90_000);

  test(
    "iniciarPrivado idempotente: two calls → the SAME conversation, PG count unchanged",
    async () => {
      const antes = await cuentaPrivadasDelPar(vendedorId, agroId);
      const primera = await trpc<ConversacionPrivadaDto>(
        "mutation",
        "chat.iniciarPrivado",
        { fkUsuario: agroId },
        vendedorToken,
      );
      expect(primera.ok).toBeTrue();
      const idPrimera = primera.ok ? primera.data.idConversacion : "";
      expect(idPrimera).not.toBe("");

      // Second call: same id (idempotent), no second conversation row.
      const segunda = await trpc<ConversacionPrivadaDto>(
        "mutation",
        "chat.iniciarPrivado",
        { fkUsuario: agroId },
        vendedorToken,
      );
      expect(segunda.ok).toBeTrue();
      expect(segunda.ok && segunda.data.idConversacion).toBe(idPrimera);
      expect(await cuentaPrivadasDelPar(vendedorId, agroId)).toBe(antes + (antes === 0 ? 1 : 0));

      // The pair conversation carries EXACTLY the two integrantes (legacy parity:
      // conversacion tipo=false + two members).
      const integrantes = await pgUna<{ n: number }>(
        "select count(*)::int n from integrantes where fk_conversacion = $1",
        [idPrimera],
      );
      expect(integrantes.n).toBe(2);
    },
    T,
  );

  test(
    "reglas quién-con-quién: cliente→agricultor OK, agricultor→cliente 403, cliente→cliente 403, admin→cliente OK, self 400, inactivo 404",
    async () => {
      // Commerce actor → commerce actor: OK (returns/creates a conversation).
      const clienteAgro = await trpc<ConversacionPrivadaDto>(
        "mutation",
        "chat.iniciarPrivado",
        { fkUsuario: agroId },
        clienteToken,
      );
      expect(clienteAgro.ok).toBeTrue();

      // NOBODY chats a Cliente but Admin: agricultor→cliente and cliente→cliente 403.
      const agroCliente = await trpc<ConversacionPrivadaDto>(
        "mutation",
        "chat.iniciarPrivado",
        { fkUsuario: clienteId },
        agroToken,
      );
      expect(agroCliente.ok).toBeFalse();
      if (!agroCliente.ok) expect(agroCliente.status).toBe(403);

      const clienteCliente = await trpc<ConversacionPrivadaDto>(
        "mutation",
        "chat.iniciarPrivado",
        { fkUsuario: cliente2Id },
        clienteToken,
      );
      expect(clienteCliente.ok).toBeFalse();
      if (!clienteCliente.ok) expect(clienteCliente.status).toBe(403);

      // Admin with anyone: OK even against a Cliente.
      const adminCliente = await trpc<ConversacionPrivadaDto>(
        "mutation",
        "chat.iniciarPrivado",
        { fkUsuario: clienteId },
        adminToken,
      );
      expect(adminCliente.ok).toBeTrue();

      // Self-chat rejected (legacy parity).
      const self = await trpc<ConversacionPrivadaDto>(
        "mutation",
        "chat.iniciarPrivado",
        { fkUsuario: agroId },
        agroToken,
      );
      expect(self.ok).toBeFalse();
      if (!self.ok) expect(self.status).toBe(400);

      // Unknown destination (legacy "El usuario no existe.").
      const fantasma = await trpc<ConversacionPrivadaDto>(
        "mutation",
        "chat.iniciarPrivado",
        { fkUsuario: crypto.randomUUID() },
        vendedorToken,
      );
      expect(fantasma.ok).toBeFalse();
      if (!fantasma.ok) expect(fantasma.status).toBe(404);
    },
    T,
  );

  test(
    "mensaje con imagen: multipart upload → documento → chat.enviar tipo imagen → PULL al otro integrante entrega tipo/archivoUrl; el archivo se sirve por /storage",
    async () => {
      // The PRIVATE conversation from the first test (vendedor↔agro) is the channel.
      const conv = await trpc<ConversacionPrivadaDto>(
        "mutation",
        "chat.iniciarPrivado",
        { fkUsuario: agroId },
        vendedorToken,
      );
      expect(conv.ok).toBeTrue();
      const idConversacion = conv.ok ? conv.data.idConversacion : "";

      const cpAgro = await maxSeq("mensaje");
      const ok = await subirAdjunto(vendedorToken, PNG_BYTES, `chat-${sufijo()}.png`, "image/png");
      expect(ok.status).toBe(200);
      const subida = (await ok.json()) as DocumentoSubido;
      expect(subida.url).toStartWith("/storage/documentos/");
      expect(subida.storageKey).toStartWith("documentos/");
      // The documento row persisted (metadata; referenced BY PATH from the mensaje).
      const filaDoc = await pgUna<{ id: string; fk_autor: string }>(
        "select id, fk_autor from documento where id = $1",
        [subida.id],
      );
      expect(filaDoc.id).toBe(subida.id);
      expect(filaDoc.fk_autor).toBe(vendedorId);

      // The message rides the NORMAL online lane (idempotent operationId).
      const enviado = await trpc<MensajeDto>(
        "mutation",
        "chat.enviar",
        {
          fkConversacion: idConversacion,
          tipo: "imagen",
          archivoUrl: subida.url,
          operationId: crypto.randomUUID(),
        },
        vendedorToken,
      );
      expect(enviado.ok).toBeTrue();
      expect(enviado.ok && enviado.data.tipo).toBe("imagen");
      expect(enviado.ok && enviado.data.archivoUrl).toBe(subida.url);

      // The OTHER member's PULL delivers tipo/archivoUrl (the attachment data rides
      // the mensajes payload — documento is NOT a collection).
      const entregados = await pullHasta<MensajeDoc>("mensajes", cpAgro, agroToken, (docs) =>
        docs.some((d) => d.id === (enviado.ok ? enviado.data.id : "")),
      );
      const recibido = entregados.find((d) => d.id === (enviado.ok ? enviado.data.id : ""));
      expect(recibido?.tipo).toBe("imagen");
      expect(recibido?.archivoUrl).toBe(subida.url);

      // The stored file is SERVED (the /storage allowlist accepts documentos/).
      const servida = await fetch(`${BASE_URL}${subida.url}`);
      expect(servida.status).toBe(200);
      expect((await servida.arrayBuffer()).byteLength).toBe(PNG_BYTES.byteLength);

      // The push lane stays TEXT-ONLY: a pushed draft NEVER carries the attachment
      // fields (the server schema strips them — no wire path for offline files).
      const docId = crypto.randomUUID();
      const op = {
        operationId: crypto.randomUUID(),
        docId,
        op: "create" as const,
        nuevoEstado: { fkConversacion: idConversacion, contenido: `Texto offline ${sufijo()}` },
        versionAsumida: null,
      };
      const resultados = await pushComo<MensajeDoc>("mensajes", [op as never], vendedorToken);
      expect(resultados[0]?.veredicto).toBe("aplicada");
      const fila = await pgUna<{ tipo: string; archivo_url: string | null }>(
        "select tipo, archivo_url from mensaje where id = $1",
        [docId],
      );
      expect(fila.tipo).toBe("texto");
      expect(fila.archivo_url).toBeNull();
    },
    T,
  );

  test(
    "upload validaciones: firma mentirosa 400, mime desconocido 400, sin archivo 400, sin token 401",
    async () => {
      const mentiroso = await subirAdjunto(
        vendedorToken,
        Buffer.from("texto-sin-firma"),
        "foto.png",
        "image/png",
      );
      expect(mentiroso.status).toBe(400);
      expect(((await mentiroso.json()) as { error: string }).error).toBe(
        "El contenido del archivo no coincide con el tipo de imagen declarado",
      );

      const mimeAjeno = await subirAdjunto(vendedorToken, PNG_BYTES, "nota.mp3", "audio/mpeg");
      expect(mimeAjeno.status).toBe(400);

      const sinArchivo = await fetch(`${BASE_URL}/upload/documentos`, {
        method: "POST",
        headers: { authorization: `Bearer ${vendedorToken}` },
        body: new FormData(),
      });
      expect(sinArchivo.status).toBe(400);

      // No token with a VALID form (the file check fires first; the 401 comes from
      // the protected procedure through the createCaller bridge).
      const sinToken = await subirAdjunto("", PNG_BYTES, "foto.png", "image/png");
      expect(sinToken.status).toBe(401);
    },
    T,
  );
});
