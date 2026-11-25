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
  /**
   * `carpeta` namespaces the generated key (e.g. "productos" master images vs
   * "documentos" chat attachments); defaults to the master-catalog folder.
   */
  save(data: Uint8Array, ext: string, carpeta?: string): Promise<GuardadoStorage>;
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

// P1-D Chat WS notifier (user decision 2026-11-20: WS = NOTIFIER ONLY, never
// transport — S3 remains the source of truth). Injected by the transport like
// storage: the chat router publishes chat events after writing the outbox row and
// apps/server fans them out to the authenticated sockets of the target users.
export type EventoChat = {
  // T6 (gap-pass-9): "grupo" nudges conversation-list refreshes for group lifecycle
  // (created / renamed / membership changed) — carries no payload beyond the id.
  tipo: "mensaje_nuevo" | "leido" | "grupo";
  conversacionId: string;
  idMensaje: string | null;
};

// Q-28 (gap-pass-9) in-app pedido notifications ride the SAME notifier channel:
// the pagos router emits ONE event targeted at the pedido's cliente user id and
// the hub fans it out to that user's authenticated sockets. Live-only contract:
// events missed while the client is offline are NOT replayed — the pedido state
// history (historial_estado_pedido) and query polling are the reliability layer.
// `mensaje` is user-facing copy (Spanish, like every other end-user string here).
export type EventoPedido = {
  tipo: "pedido";
  pedidoId: string;
  folio: string;
  estadoNuevo: string;
  mensaje: string;
};

export type NotificadorChat = {
  /** Best-effort in-process fanout; no recipients connected → no-op. */
  publicar(destinatarios: readonly string[], evento: EventoChat | EventoPedido): void;
};

export type Context = {
  db: Database;
  cookies: CookieStore;
  auth: AuthRuntime;
  storage: StorageAdapter;
  notificador: NotificadorChat;
  // Null when the Authorization header is absent/invalid/expired; public procedures
  // (login, refresh, healthCheck) still resolve.
  user: ContextUser | null;
  // Client network identity injected by the transport (apps/server/src/context.ts):
  // ip = first X-Forwarded-For hop, else the socket remote address; dispositivo =
  // User-Agent truncated to 200. Null when undetectable — the audit writer
  // (registrarLog) then falls back to its NOT NULL "unknown" sentinel.
  ip: string | null;
  dispositivo: string | null;
};
