import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { verifyAccessToken } from "@rassa-jala/api/auth";
import { appRouter } from "@rassa-jala/api/routers/index";
import { MAX_BYTES } from "@rassa-jala/api/routers/productos";
import { MAX_MEDIA_BYTES } from "@rassa-jala/api/lib/media-firma";

import { createContext } from "./context";
import { ENV } from "./env.server";
import { storage } from "./services";
import { quitarSocket, registrarSocket } from "./services/ws-hub";

const app = new Hono();
const origins = ENV.CORS_ORIGIN.split(",").map((s) => s.trim());

const corsUpload = {
  origin: origins,
  allowMethods: ["POST", "OPTIONS"],
  // P0 auth: the httpOnly refresh cookie and the Authorization header travel
  // cross-origin from the web app, so credentials must be allowed explicitly.
  credentials: true,
  // ngrok-skip-browser-warning: the web client sends it to bypass the ngrok-free
  // interstitial (ERR_NGROK_6024); the preflight must allow it or CORS fails.
  allowHeaders: ["authorization", "content-type", "ngrok-skip-browser-warning"],
};

app.use(
  "/trpc/*",
  cors({
    ...corsUpload,
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);
app.use("/upload/*", cors(corsUpload));

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext,
  }),
);

// gap 3 (transport debt): multipart upload for product images. Bun parses
// multipart/form-data natively, so the File bytes ride the wire as binary — no
// base64-in-JSON. The web client uses this route; the base64 tRPC procedures remain
// authoritative for old clients (coexistence). AUTH + business logic stays in ONE
// home: the request is bridged into the SAME procedures via createCaller, so
// protectedProcedure re-verifies estado/password/fresh role per call.
app.post("/upload/imagenes", async (c) => {
  const ctx = await createContext({ req: c.req.raw, resHeaders: new Headers() }, c);
  const form = await c.req.raw.formData().catch(() => null);
  if (!form) {
    return c.json({ error: "Cuerpo multipart inválido" }, 400);
  }
  const archivo = form.get("file");
  const fkProducto = form.get("fkProducto");
  const fkProductoSemanal = form.get("fkProductoSemanal");
  if (!(archivo instanceof File)) {
    return c.json({ error: "Falta el archivo de imagen" }, 400);
  }
  if (archivo.size > MAX_BYTES) {
    return c.json({ error: "La imagen supera el tamaño máximo de 5 MiB" }, 400);
  }
  if ((typeof fkProducto === "string") === (typeof fkProductoSemanal === "string")) {
    return c.json({ error: "Indica exactamente un destino: fkProducto o fkProductoSemanal" }, 400);
  }
  // In-process base64 bridge: the procedures' zod pipeline (size, signature, extension)
  // and their persistence remain authoritative — the base64 never travels the wire.
  const dataBase64 = Buffer.from(await archivo.arrayBuffer()).toString("base64");
  const datos = {
    fileName: archivo.name,
    // The procedures' zod enum is the validator: an unknown type string is rejected 400.
    mimeType: archivo.type as "image/png" | "image/jpeg" | "image/webp",
    dataBase64,
  };
  const caller = appRouter.createCaller(ctx);
  try {
    const resultado =
      typeof fkProducto === "string"
        ? await caller.productos.imagenes.upload({ ...datos, fkProducto })
        : await caller.publicaciones.imagenes.upload({
            ...datos,
            // XOR guard above leaves exactly one destination set.
            fkProductoSemanal: fkProductoSemanal as string,
          });
    return c.json(resultado);
  } catch (error) {
    // Same HTTP semantics the tRPC transport produces for the client's error toasts.
    if (error instanceof TRPCError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: getHTTPStatusCodeFromError(error),
        headers: { "content-type": "application/json" },
      });
    }
    throw error;
  }
});

// T17 (gap-pass-7) + T6 (gap-pass-9): multipart upload for CHAT attachments. Same
// bridge pattern as /upload/imagenes — the request hops into chat.documentos.upload
// via createCaller so auth, the signature chain (asegurarFirmaImagen for images,
// asegurarFirmaMedia for audio/video) and the documento persistence stay in ONE home.
// Returns { id, url, storageKey }: the message that references the file is sent
// afterwards through chat.enviar (tipo "imagen"|"audio"|"video" + archivoUrl) — the
// FILE never enters a sync lane, only its URL travels.
app.post("/upload/documentos", async (c) => {
  const ctx = await createContext({ req: c.req.raw, resHeaders: new Headers() }, c);
  const form = await c.req.raw.formData().catch(() => null);
  if (!form) {
    return c.json({ error: "Cuerpo multipart inválido" }, 400);
  }
  const archivo = form.get("file");
  if (!(archivo instanceof File)) {
    return c.json({ error: "Falta el archivo de imagen" }, 400);
  }
  // Loose bridge gate: the media ceiling (15 MiB). Per-type limits (images 5 MiB,
  // media 15 MiB) stay authoritative in the procedure's decodificarBase64(Media).
  if (archivo.size > MAX_MEDIA_BYTES) {
    return c.json({ error: "El archivo supera el tamaño máximo de 15 MiB" }, 400);
  }
  const dataBase64 = Buffer.from(await archivo.arrayBuffer()).toString("base64");
  const caller = appRouter.createCaller(ctx);
  try {
    const resultado = await caller.chat.documentos.upload({
      fileName: archivo.name,
      // The procedure's MIME maps (MIME_PERMITIDOS / MIME_MEDIA) are the validators:
      // an unknown type string is rejected 400.
      mimeType: archivo.type,
      dataBase64,
    });
    return c.json(resultado);
  } catch (error) {
    // Same HTTP semantics the tRPC transport produces for the client's error toasts.
    if (error instanceof TRPCError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: getHTTPStatusCodeFromError(error),
        headers: { "content-type": "application/json" },
      });
    }
    throw error;
  }
});

// Gap-pass-8 profile photo: same bridge pattern as /upload/documentos — auth +
// image-signature chain + the persona update stay in ONE home (usuarios.subirFoto,
// own-persona only). Returns { fotoKey, fotoUrl } for the client's immediate render;
// `auth.me` is the durable read-back.
app.post("/upload/perfil", async (c) => {
  const ctx = await createContext({ req: c.req.raw, resHeaders: new Headers() }, c);
  const form = await c.req.raw.formData().catch(() => null);
  if (!form) {
    return c.json({ error: "Cuerpo multipart inválido" }, 400);
  }
  const archivo = form.get("file");
  if (!(archivo instanceof File)) {
    return c.json({ error: "Falta el archivo de imagen" }, 400);
  }
  if (archivo.size > MAX_BYTES) {
    return c.json({ error: "La imagen supera el tamaño máximo de 5 MiB" }, 400);
  }
  const dataBase64 = Buffer.from(await archivo.arrayBuffer()).toString("base64");
  const caller = appRouter.createCaller(ctx);
  try {
    const resultado = await caller.usuarios.subirFoto({
      fileName: archivo.name,
      // The procedure's zod enum is the validator: an unknown type string is rejected 400.
      mimeType: archivo.type as "image/png" | "image/jpeg" | "image/webp",
      dataBase64,
    });
    return c.json(resultado);
  } catch (error) {
    // Same HTTP semantics the tRPC transport produces for the client's error toasts.
    if (error instanceof TRPCError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: getHTTPStatusCodeFromError(error),
        headers: { "content-type": "application/json" },
      });
    }
    throw error;
  }
});

app.get("/", (c) => {
  return c.text("OK");
});

// Dev serving of stored images (D-1 local driver). The path allowlist IS the traversal
// guard: only "<folder>/<uuid>.<ext>" keys (the ones the adapters generate) pass —
// no "..", no other chars. With the remote driver (P0-C) the route redirects to a
// short-lived signed URL instead of serving bytes. T6 (gap-pass-9): chat media
// extensions ride the documentos/ folder too.
const CONTENIDO_POR_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  webm: "video/webm",
  mov: "video/quicktime",
} as const;

// (productos|documentos|perfil): the adapters' generated keys — master-catalog images,
// T17/T6 chat attachments and gap-pass-8 profile photos (all <uuid>.<ext> under their
// folder; the allowlist IS the traversal guard).
const CLAVE_VALIDA =
  /^(productos|documentos|perfil)\/[0-9a-f-]{36}\.(png|jpe?g|webp|mp3|wav|m4a|mp4|ogg|webm|mov)$/;

app.get("/storage/*", async (c) => {
  const clave = c.req.path.slice("/storage/".length);
  if (!CLAVE_VALIDA.test(clave)) {
    return c.text("Clave de almacenamiento inválida", 400);
  }
  const ruta = storage.localPath?.(clave);
  if (!ruta) {
    // Remote driver (P0-C): mint a short-lived signed URL and redirect — the
    // persisted url stays a stable server path, the bucket stays private.
    if (!storage.signedUrl) return c.text("Servido local no disponible", 404);
    try {
      return c.redirect(await storage.signedUrl(clave), 302);
    } catch {
      return c.text("No se pudo firmar el objeto remoto", 502);
    }
  }
  const file = Bun.file(ruta);
  if (!(await file.exists())) return c.text("Archivo no encontrado", 404);
  const extension = clave.split(".").pop() ?? "";
  const contentType =
    CONTENIDO_POR_EXTENSION[extension as keyof typeof CONTENIDO_POR_EXTENSION] ??
    "application/octet-stream";
  return new Response(file, { headers: { "content-type": contentType } });
});

// slice-decision: PORT is not part of the varlock schema; plain process env with the scaffold's
// default of 3000.
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const host = process.env.HOST ?? "0.0.0.0";

// P1-D Chat WS notifier (M-18): Bun-native websocket on the SAME Bun.serve. Path /ws;
// the access JWT (15-min TTL) is validated AT UPGRADE from ?token= — unauthenticated
// upgrades are rejected with 401. Re-auth policy (documented, kept simple): the
// socket is a read-only notifier carrying no privileged data beyond what tRPC
// polling would deliver anyway, so no periodic re-auth challenge exists; the client
// reconnects with a fresh token on every close (backoff) and the 45 s query polling
// is the correctness fallback if the token expired mid-connection.
Bun.serve<{ idUsuario: string }>({
  hostname: host,
  port,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const token = url.searchParams.get("token");
      const user = token ? await verifyAccessToken(token, ENV.JWT_ACCESS_SECRET) : null;
      if (!user) {
        return new Response("No autenticado", { status: 401 });
      }
      return server.upgrade(req, { data: { idUsuario: user.id } })
        ? undefined
        : new Response("Upgrade fallido", { status: 400 });
    }
    // Pass the Bun server as the Hono Env: createContext reads the request's socket
    // address through c.env.requestIP (Bun-native; the Request object alone has none).
    return app.fetch(req, server);
  },
  websocket: {
    open(ws) {
      registrarSocket(ws.data.idUsuario, ws);
    },
    close(ws) {
      quitarSocket(ws.data.idUsuario, ws);
    },
    // Notifier-only: inbound frames are ignored (P2 presence/typing would live here).
    message() {},
  },
});

console.log(`Server is running on http://localhost:${port}`);
