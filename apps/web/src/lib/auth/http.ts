import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { getServerUrl } from "@/lib/server-url";
import { getAccessToken, sessionExpired, setSession, type SessionUser } from "./session";

const TRPC_URL = `${getServerUrl()}/trpc`;

export type SesionRespuesta = { accessToken: string; user: SessionUser };

// Refresh uses its own transport: cookie-only (httpOnly cookie rides via credentials),
// NO Authorization header and NO 401 auto-retry — otherwise a failed refresh recurses.
const refreshClient = createTRPCUntypedClient<AnyRouter>({
  links: [
    httpBatchLink({
      url: TRPC_URL,
      // Same ngrok-free interstitial skip as authFetch; this transport stays
      // separate on purpose (cookie-only refresh: no Authorization header).
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: { ...init?.headers, "ngrok-skip-browser-warning": "true" },
          credentials: "include",
        }),
    }),
  ],
});

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Cross-tab refresh serialization (multi-tab QA fix). The refresh token rotates on
 * EVERY refresh AND the server treats presenting an already-rotated token as theft,
 * revoking the user's ENTIRE session family (auth.refresh "Sesión revocada por
 * seguridad"). Two tabs refreshing concurrently therefore kill each other's sessions:
 * the loser presents the token the winner just rotated, the family dies, and both
 * tabs end up in a 401 cascade that never settles. navigator.locks serializes
 * refreshes browser-wide: the queued tab refreshes with the NEWEST cookie once the
 * leader finishes, so a revoked token is never presented. The lock is released
 * automatically when a tab dies; where the API is missing (insecure contexts, unit
 * test runtimes) we degrade to the previous per-tab behavior.
 */
async function conLockMultiPestana<T>(tarea: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return tarea();
  return navigator.locks.request("rassa-auth-refresh", tarea);
}

/**
 * Distinguishes a REAL session end (the server answered: 401/403, e.g. rotated or
 * revoked cookie) from a transient failure (network / 5xx — e.g. the dev API server
 * still booting on cold start, gap 15c). Only the first destroys the session; on a
 * transient failure the still-valid session is kept untouched.
 */
function esRechazoSesion(error: unknown): boolean {
  const data = (error as { data?: { httpStatus?: number; code?: string } })?.data;
  return data?.httpStatus === 401 || data?.httpStatus === 403 || data?.code === "UNAUTHORIZED";
}

async function intentarRefresh(): Promise<"ok" | "rechazada" | "red"> {
  try {
    const res = (await refreshClient.mutation("auth.refresh", null)) as SesionRespuesta;
    setSession(res.user, res.accessToken);
    return "ok";
  } catch (error) {
    if (esRechazoSesion(error)) {
      sessionExpired();
      return "rechazada";
    }
    // Network / 5xx: the server never evaluated the cookie — the session survives
    // (sessionExpired is NOT called, so the expiry handler never fires).
    return "red";
  }
}

/**
 * Single-flight silent refresh: one in-flight refresh serves every concurrent 401
 * (per tab) and the cross-tab lock serializes the rotation browser-wide.
 * True = a new access token was stored; false = no token could be obtained.
 *
 * Cold-start guard (gap 15c): the dev API server may still be booting when the first
 * protected navigation fires; one short retry on a TRANSIENT failure recovers
 * silently instead of bouncing to /login. A real auth rejection never retries.
 */
export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= conLockMultiPestana(async () => {
    try {
      const primera = await intentarRefresh();
      if (primera === "ok") return true;
      if (primera === "rechazada") return false;
      await new Promise((resolve) => setTimeout(resolve, 700));
      return (await intentarRefresh()) === "ok";
    } finally {
      refreshInFlight = null;
    }
  });
  return refreshInFlight;
}

/** Authorization header for the current session (empty when logged out). */
export function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Shared transport for every server call (app tRPC client + sync replication client):
 * - attaches the Bearer access token from the in-memory session store;
 * - always sends cookies (credentials: include) so the httpOnly refresh cookie rides along;
 * - on the FIRST 401 of a sessioned request, silently refreshes once and retries with the
 *   new token; if the refresh fails the session is cleared and the expiry handler (main.tsx)
 *   redirects to /login.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = (token: string | null): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    // ngrok-free interstitial (ERR_NGROK_6024) hijacks browser-UA GETs without
    // this header; harmless elsewhere (only ngrok reads it).
    headers.set("ngrok-skip-browser-warning", "true");
    return fetch(input, { ...init, headers, credentials: "include" });
  };

  const first = await request(getAccessToken());
  // No session → the 401 is a plain rejection (e.g. wrong password at login): no refresh.
  if (first.status !== 401 || !getAccessToken()) return first;
  if (!(await refreshSession())) return first;
  return request(getAccessToken());
}
