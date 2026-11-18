import { useSyncExternalStore } from "react";

/**
 * Session store (tiny external store, no new dependencies) — P0 Autenticación.
 *
 * The access JWT lives in memory only (dies with the tab); the refresh token never
 * touches JS: it is an httpOnly cookie issued by the server (F-04 fix — one uniform
 * storage contract for every client, no localStorage/sessionStorage split).
 */
export type SessionUser = {
  id: string;
  email: string;
  rol: string;
  // Q-07 forced-change flag from login/refresh/auth.me; cleared client-side after
  // auth.changePassword succeeds.
  debeCambiarPassword?: boolean;
};

export type SessionState = {
  token: string | null;
  user: SessionUser | null;
};

let state: SessionState = { token: null, user: null };
const listeners = new Set<() => void>();
let expiredHandler: (() => void) | null = null;

function emit(): void {
  state = { ...state };
  for (const listener of listeners) listener();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSession(): SessionState {
  return state;
}

export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, getSession);
}

export function getAccessToken(): string | null {
  return state.token;
}

export function setSession(user: SessionUser, token: string): void {
  state = { token, user };
  emit();
}

/** Clears the session; if an expiry handler is installed it drives the /login redirect. */
export function sessionExpired(): void {
  state = { token: null, user: null };
  emit();
  expiredHandler?.();
}

/** Installed once at bootstrap (main.tsx) so the transport can react to session loss. */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  expiredHandler = handler;
}
