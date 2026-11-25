import type { Context as HonoContext } from "hono";

import type { Context as ApiContext } from "@rassa-jala/api/context";
import { verifyAccessToken } from "@rassa-jala/api/auth";

import { createCookieStore } from "./cookies";
import { ENV } from "./env.server";
import { db, storage } from "./services";
import { hub } from "./services/ws-hub";

// P0 auth: the Bearer access JWT of the Authorization header is verified per request
// (backend-audit §2.2 AUTH_HEADER_TYPES=Bearer). Absent/invalid/expired → user: null;
// public procedures (login, refresh, logout, healthCheck) still resolve, and
// protectedProcedure rejects the rest.
//
// The @hono/trpc-server adapter passes its Hono context as a second argument, which the
// cookie store needs to READ the request cookie jar (writes go through the adapter's own
// resHeaders).
//
// The opts shape is the minimal slice both transports provide: the tRPC fetch adapter's
// FetchCreateContextFnOptions (structurally), and the Hono-direct multipart upload route
// (index.ts) which builds { req, resHeaders } itself.
export async function createContext(
  opts: { req: Request; resHeaders: Headers },
  c: HonoContext,
): Promise<ApiContext> {
  const header = opts.req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const user = token ? await verifyAccessToken(token, ENV.JWT_ACCESS_SECRET) : null;
  // Audit trail source (M-7): X-Forwarded-For's first hop wins; otherwise the socket
  // remote address. The Bun server instance arrives as the Hono Env (index.ts passes
  // it to app.fetch); requestIP must receive the ORIGINAL Request — the tRPC adapter
  // proxies opts.req for POST bodies and Bun rejects proxies ("Expected Request
  // object"). requestIP is guarded because a closed connection must never break
  // context creation.
  type BunServer = { requestIP(req: Request): { address: string } | null };
  const bunServer = c.env as BunServer | undefined;
  let remoteAddress: string | null = null;
  try {
    remoteAddress = bunServer?.requestIP(c.req.raw)?.address ?? null;
  } catch {
    remoteAddress = null;
  }
  const forwarded = opts.req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const dispositivo = opts.req.headers.get("user-agent")?.trim() || null;
  return {
    db,
    storage,
    user,
    notificador: hub.notificador,
    ip: forwarded || remoteAddress || null,
    dispositivo: dispositivo ? dispositivo.slice(0, 200) : null,
    auth: {
      accessSecret: ENV.JWT_ACCESS_SECRET,
      refreshSecret: ENV.JWT_REFRESH_SECRET,
      secureCookies: ENV.NODE_ENV === "production",
    },
    cookies: createCookieStore(opts, c),
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
