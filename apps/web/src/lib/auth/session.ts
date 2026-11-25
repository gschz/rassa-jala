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
  // Normative sync §11: purge the local replica when the account changes.
  purgarSiCambioUsuario(user.id);
  state = { token, user };
  emit();
}

/** Clears the session; if an expiry handler is installed it drives the /login redirect. */
export function sessionExpired(): void {
  state = { token: null, user: null };
  emit();
  expiredHandler?.();
}

const LAST_USER_KEY = "rassa-last-user-id";

/**
 * Normative sync §11: local RxDB replicas are per-identity — on user change the
 * local database must be purged, or the next account's push queue retries the
 * previous account's documents (observed in QA: 403 storms on
 * sync.publicaciones.push after switching accounts). Returns true when a purge
 * (async, fire-and-forget delete + reload) was performed.
 */
export function purgarSiCambioUsuario(nuevoUserId: string): boolean {
  // Headless bun test runs have no localStorage — skip the guard there
  // (the purge matters in the browser only).
  if (typeof localStorage === "undefined") return false;
  const previo = localStorage.getItem(LAST_USER_KEY);
  if (previo === null) {
    localStorage.setItem(LAST_USER_KEY, nuevoUserId);
    return false;
  }
  if (previo === nuevoUserId) return false;
  localStorage.setItem(LAST_USER_KEY, nuevoUserId);
  // Close RxDB first: an open handle BLOCKS indexedDB.deleteDatabase forever.
  void import("@/lib/rxdb/database").then(({ purgarBaseLocal }) => purgarBaseLocal());
  return true;
}

/** Installed once at bootstrap (main.tsx) so the transport can react to session loss. */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  expiredHandler = handler;
}
