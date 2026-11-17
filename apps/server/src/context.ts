import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { Context as HonoContext } from "hono";

import type { Context as ApiContext } from "@rassa-jala/api/context";
import { verifyAccessToken } from "@rassa-jala/api/auth";

import { createCookieStore } from "./cookies";
import { ENV } from "./env.server";
import { db } from "./services";

// P0 auth: the Bearer access JWT of the Authorization header is verified per request
// (backend-audit §2.2 AUTH_HEADER_TYPES=Bearer). Absent/invalid/expired → user: null;
// public procedures (login, refresh, logout, healthCheck) still resolve, and
// protectedProcedure rejects the rest.
//
// The @hono/trpc-server adapter passes its Hono context as a second argument, which the
// cookie store needs to READ the request cookie jar (writes go through the adapter's own
// resHeaders).
export async function createContext(
  opts: FetchCreateContextFnOptions,
  c: HonoContext,
): Promise<ApiContext> {
  const header = opts.req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const user = token ? await verifyAccessToken(token, ENV.JWT_ACCESS_SECRET) : null;
  return {
    db,
    user,
    auth: {
      accessSecret: ENV.JWT_ACCESS_SECRET,
      refreshSecret: ENV.JWT_REFRESH_SECRET,
      secureCookies: ENV.NODE_ENV === "production",
    },
    cookies: createCookieStore(opts, c),
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
