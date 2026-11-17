import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { ENV } from "../../env";
import { getAccessToken, sessionExpired, setSession, type SessionUser } from "./session";

const TRPC_URL = `${ENV.VITE_SERVER_URL.replace(/\/$/, "")}/trpc`;

export type SesionRespuesta = { accessToken: string; user: SessionUser };

// Refresh uses its own transport: cookie-only (httpOnly cookie rides via credentials),
// NO Authorization header and NO 401 auto-retry — otherwise a failed refresh recurses.
const refreshClient = createTRPCUntypedClient<AnyRouter>({
  links: [
    httpBatchLink({
      url: TRPC_URL,
      fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
    }),
  ],
});

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Single-flight silent refresh: one in-flight refresh serves every concurrent 401.
 * True = a new access token was stored; false = the session is over.
 */
export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = (await refreshClient.mutation("auth.refresh", null)) as SesionRespuesta;
      setSession(res.user, res.accessToken);
      return true;
    } catch {
      sessionExpired();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
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
    return fetch(input, { ...init, headers, credentials: "include" });
  };

  const first = await request(getAccessToken());
  // No session → the 401 is a plain rejection (e.g. wrong password at login): no refresh.
  if (first.status !== 401 || !getAccessToken()) return first;
  if (!(await refreshSession())) return first;
  return request(getAccessToken());
}
