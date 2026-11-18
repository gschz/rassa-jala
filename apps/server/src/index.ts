import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { appRouter } from "@rassa-jala/api/routers/index";

import { createContext } from "./context";
import { ENV } from "./env.server";
import { storage } from "./services";

const app = new Hono();

app.use(
  "/trpc/*",
  cors({
    origin: ENV.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    // P0 auth: the httpOnly refresh cookie and the Authorization header travel
    // cross-origin from the web app, so credentials must be allowed explicitly.
    credentials: true,
    allowHeaders: ["authorization", "content-type"],
  }),
);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext,
  }),
);

app.get("/", (c) => {
  return c.text("OK");
});

// Dev serving of stored images (D-1 local driver). The path allowlist IS the traversal
// guard: only "productos/<uuid>.<ext>" keys (the ones the adapter generates) pass —
// no "..", no other chars. With a remote driver (Supabase) this route serves nothing.
const CONTENIDO_POR_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;

const CLAVE_VALIDA = /^productos\/[0-9a-f-]{36}\.(png|jpe?g|webp)$/;

app.get("/storage/*", async (c) => {
  const clave = c.req.path.slice("/storage/".length);
  if (!CLAVE_VALIDA.test(clave)) {
    return c.text("Clave de almacenamiento inválida", 400);
  }
  const ruta = storage.localPath?.(clave);
  if (!ruta) return c.text("Servido local no disponible", 404);
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

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Server is running on http://localhost:${port}`);
