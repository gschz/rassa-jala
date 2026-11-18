import type { Database } from "@rassa-jala/db";

// Data-driven roles (backend-audit §2.1): the canonical vocabulary is the DB's Spanish
// strings (F-26 unification — the DB rows are the single source, no per-layer aliases).
export const ROLE = {
  ADMIN: "Admin",
  AGRICULTOR: "Agricultor",
  VENDEDOR: "Vendedor",
  CLIENTE: "Cliente",
} as const;

export type Role = (typeof ROLE)[keyof typeof ROLE];

// Identity resolved from the verified access JWT. The rol claim carries the DB rol name;
// unknown future roles simply fail role checks (deny by default).
export type ContextUser = {
  id: string;
  email: string;
  rol: Role;
};

// D-1 storage capability injected by the transport (apps/server wires the real driver:
// local disk in dev, Supabase at final integration). This package stays storage-agnostic.
export type GuardadoStorage = {
  storageKey: string;
  url: string;
};

export type StorageAdapter = {
  save(data: Uint8Array, ext: string): Promise<GuardadoStorage>;
  remove(storageKey: string): Promise<void>;
};

// Cookie capability injected by the transport (apps/server) so this package stays
// transport-agnostic. set()/delete() queue the operation; the transport flushes them
// onto the response after the tRPC middleware returns.
export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  maxAge?: number;
  path?: string;
};

export type CookieStore = {
  get(name: string): string | undefined;
  set(name: string, value: string, options?: CookieOptions): void;
  delete(name: string): void;
};

// Static auth configuration injected from the server env: secrets never live in this
// package (architecture.md §7 — the backend is the only secret holder).
export type AuthRuntime = {
  accessSecret: string;
  refreshSecret: string;
  secureCookies: boolean;
};

export type Context = {
  db: Database;
  cookies: CookieStore;
  auth: AuthRuntime;
  storage: StorageAdapter;
  // Null when the Authorization header is absent/invalid/expired; public procedures
  // (login, refresh, healthCheck) still resolve.
  user: ContextUser | null;
};
