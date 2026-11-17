import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { appRouter } from "@rassa-jala/api/routers/index";

import { createContext } from "./context";
import { ENV } from "./env.server";

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

// slice-decision: PORT is not part of the varlock schema; plain process env with the scaffold's
// default of 3000.
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Server is running on http://localhost:${port}`);
