import "varlock/auto-load";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { AnyRouter } from "@trpc/server";

import { refreshSession } from "./http";
import { getAccessToken, setSession, setSessionExpiredHandler, type SessionUser } from "./session";

type Comportamiento = "ok" | "rechazada" | "red";

const USUARIO: SessionUser = { id: "u1", email: "a@b.c", rol: "Admin" };

// Real server-side serialization: the router behavior switches per test and the
// client under test (http.ts refreshClient) runs unmodified over the wire response —
// a true round trip, no hand-crafted envelopes. The cross-tab lock is exercised in
// the browser only (navigator.locks); bun lacks it, so these tests cover the
// fallback path plus the single-flight and rejection/transient classification.
let comportamiento: Comportamiento = "ok";
let llamadas = 0;

const t = initTRPC.create();
const router: AnyRouter = t.router({
  auth: t.router({
    refresh: t.procedure.mutation(() => {
      llamadas += 1;
      if (comportamiento === "rechazada") {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Sesión revocada por seguridad" });
      }
      if (comportamiento === "red") {
        throw new TypeError("Failed to fetch");
      }
      return { accessToken: "tok-nuevo", user: USUARIO };
    }),
  }),
});

function servidorEnProceso(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (comportamiento === "red") return Promise.reject(new TypeError("Failed to fetch"));
  const req = new Request(input, init);
  return fetchRequestHandler({ endpoint: "/trpc", req, router });
}

describe("auth refresh (transport round trip)", () => {
  let fetchOriginal: typeof fetch;

  beforeEach(() => {
    comportamiento = "ok";
    llamadas = 0;
    setSessionExpiredHandler(null);
    setSession(USUARIO, "tok-viejo");
    fetchOriginal = globalThis.fetch;
    globalThis.fetch = servidorEnProceso as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    setSessionExpiredHandler(null);
  });

  it("real 401 rejection destroys the session and fires the expiry handler", async () => {
    let expiro = false;
    setSessionExpiredHandler(() => {
      expiro = true;
    });
    comportamiento = "rechazada";
    await expect(refreshSession()).resolves.toBe(false);
    expect(getAccessToken()).toBe(null);
    expect(expiro).toBe(true);
  });

  it("transient network failure keeps the session and does not fire the handler", async () => {
    let expiro = false;
    setSessionExpiredHandler(() => {
      expiro = true;
    });
    comportamiento = "red";
    await expect(refreshSession()).resolves.toBe(false);
    expect(getAccessToken()).toBe("tok-viejo");
    expect(expiro).toBe(false);
    expect(llamadas).toBe(0); // the fetch never resolved: both attempts threw
  });

  it("transient failure followed by recovery returns true", async () => {
    comportamiento = "red";
    // The 700ms cold-start retry happens inside; flip the behavior while waiting.
    setTimeout(() => {
      comportamiento = "ok";
    }, 100);
    await expect(refreshSession()).resolves.toBe(true);
    expect(getAccessToken()).toBe("tok-nuevo");
  });

  it("concurrent callers share one in-flight refresh (single-flight)", async () => {
    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(llamadas).toBe(1);
  });
});
