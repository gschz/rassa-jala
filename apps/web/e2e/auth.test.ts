import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN,
  BLOQUEADO,
  DEV_PASSWORD,
  TRPC_URL,
  ensureServer,
  login,
  trpc,
  type Sesion,
} from "./helpers";

const T = 120_000;

type RefreshRes = { accessToken: string; user: { id: string; rol: string } };

type RawBatch = Array<{ result?: { data?: unknown }; error?: { message?: string } }>;

/** Raw batched POST refresh carrying the httpOnly refresh cookie. */
async function refresh(
  cookie?: string,
): Promise<{ status: number; body: RawBatch; setCookie: string[] }> {
  const res = await fetch(`${TRPC_URL}/auth.refresh?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ 0: null }),
  });
  return {
    status: res.status,
    body: (await res.json()) as RawBatch,
    setCookie: res.headers.getSetCookie(),
  };
}

describe("auth e2e (F-01/F-02/F-03)", () => {
  beforeAll(async () => {
    await ensureServer();
  }, 60_000);

  test(
    "login ok issues access token + session user",
    async () => {
      const ses = await login(ADMIN, DEV_PASSWORD);
      expect(ses.token.length).toBeGreaterThan(20);
      expect(ses.user.email).toBe(ADMIN);
      expect(ses.user.rol).toBe("Admin");
      expect(ses.user.debeCambiarPassword).toBe(false);
      expect(ses.refreshCookie).toStartWith("rassa_refresh=");
    },
    T,
  );

  test(
    "wrong password -> 401 Credenciales inválidas",
    async () => {
      const res = await trpc("mutation", "auth.login", { email: ADMIN, password: "no-es" });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(401);
      expect(res.errorCode).toBe("UNAUTHORIZED");
      expect(res.errorMessage).toBe("Credenciales inválidas");
    },
    T,
  );

  test(
    "bloqueado (estado=false) -> 403 Usuario desactivado (F-01)",
    async () => {
      const res = await trpc("mutation", "auth.login", {
        email: BLOQUEADO,
        password: DEV_PASSWORD,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(403);
      expect(res.errorCode).toBe("FORBIDDEN");
      expect(res.errorMessage).toBe("Usuario desactivado");
    },
    T,
  );

  test(
    "refresh rotates the token; replaying the OLD cookie revokes the family (F-02)",
    async () => {
      const ses = await login(ADMIN, DEV_PASSWORD);
      expect(ses.refreshCookie).toBeDefined();

      const r1 = await refresh(ses.refreshCookie);
      expect(r1.status).toBe(200);
      const data1 = r1.body[0]?.result?.data as RefreshRes | undefined;
      expect(data1?.accessToken).toBeDefined();
      // Rotation is proven by the NEW refresh cookie (the access JWT may be byte-identical
      // when login and refresh land in the same second — iat has 1 s resolution).
      const cookie2 = r1.setCookie.find((c) => c.startsWith("rassa_refresh="))?.split(";")[0];
      expect(cookie2).toBeDefined();
      expect(cookie2).not.toBe(ses.refreshCookie);

      // Replay of the already-rotated token = theft: the WHOLE family is revoked.
      const replay = await refresh(ses.refreshCookie);
      expect(replay.status).toBe(401);
      expect(replay.body[0]?.error?.message).toBe("Sesión revocada por seguridad");

      // The rotated cookie from r1 died with the family.
      const r3 = await refresh(cookie2);
      expect(r3.status).toBe(401);
      expect(r3.body[0]?.error?.message).toBe("Sesión revocada por seguridad");
    },
    T,
  );

  test(
    "logout revokes the presented refresh token (F-03)",
    async () => {
      const ses = await login(ADMIN, DEV_PASSWORD);
      const out = await trpc("mutation", "auth.logout", undefined, null, {
        cookie: ses.refreshCookie ?? "",
      });
      expect(out.ok).toBe(true);

      const after = await refresh(ses.refreshCookie);
      expect(after.status).toBe(401);
    },
    T,
  );

  test(
    "me returns the authenticated profile",
    async () => {
      const ses: Sesion = await login(ADMIN, DEV_PASSWORD);
      const me = await trpc<{ email: string; rol: string; estado: boolean }>(
        "query",
        "auth.me",
        null,
        ses.token,
      );
      expect(me.ok).toBe(true);
      if (me.ok) {
        expect(me.data.email).toBe(ADMIN);
        expect(me.data.rol).toBe("Admin");
        expect(me.data.estado).toBe(true);
      }
    },
    T,
  );
});
