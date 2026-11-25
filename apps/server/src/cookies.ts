import { getCookie } from "hono/cookie";
import type { Context as HonoContext } from "hono";
import { serialize } from "hono/utils/cookie";

import type { CookieStore } from "@rassa-jala/api/context";
import { REFRESH_COOKIE_PATH } from "@rassa-jala/api/auth";

// The tRPC fetch adapter exposes the per-request response headers (`opts.resHeaders`,
// "which you can add to, such as to set cookies"), so the auth resolvers write cookies
// through this store and they land directly on the tRPC response. The Hono-direct
// multipart upload route passes its own fresh Headers the same way.
export function createCookieStore(opts: { resHeaders: Headers }, c: HonoContext): CookieStore {
  return {
    get: (name) => getCookie(c, name),
    set: (name, value, options) =>
      opts.resHeaders.append("set-cookie", serialize(name, value, options ?? {})),
    delete: (name) =>
      // Same path as issued → the browser drops the cookie.
      opts.resHeaders.append(
        "set-cookie",
        serialize(name, "", { path: REFRESH_COOKIE_PATH, maxAge: 0 }),
      ),
  };
}
