import { toast } from "sonner";

import { getAccessToken } from "./auth/session";
import { getServerUrl } from "./server-url";

/**
 * P1-D Chat WS client (M-18, user decision 2026-11-20): Bun-native WS as a NOTIFIER
 * ONLY — never a transport. The S3 replication stays the source of truth; this socket
 * just accelerates it: on a chat event the listener triggers query invalidation /
 * replication reSync. Polling (TanStack Query refetchInterval 45 s) is the fallback
 * whenever the socket is not "conectado" — `useWsEstado` exposes that state.
 *
 * Auth policy: the 15-min access JWT is validated AT UPGRADE (`?token=`, server-side
 * 401 on miss). No periodic re-auth challenge: the socket is a read-only notifier
 * (it carries nothing the tRPC polling wouldn't deliver anyway); on ANY close the
 * client reconnects with exponential backoff and a FRESH token read at connect time.
 * In dev the browser talks to the server origin directly (VITE_SERVER_URL), so no
 * Vite proxy is involved; production uses wss when the server URL is https.
 *
 * Q-28 (gap-pass-9): `tipo: "pedido"` events are in-app order notifications aimed
 * at the pedido's cliente (the server targets them by user id; anything arriving
 * here is for THIS session). They surface as a sonner toast and are LIVE-ONLY:
 * events missed while offline are never replayed — the pedido state history
 * (historial_estado_pedido) and query polling are the reliability layer.
 */

export type EventoChat = {
  tipo: "mensaje_nuevo" | "leido" | "grupo";
  conversacionId: string;
  idMensaje: string | null;
};

export type EventoPedido = {
  tipo: "pedido";
  pedidoId: string;
  folio: string;
  estadoNuevo: string;
  mensaje: string;
};

export type EstadoWs = "conectado" | "conectando" | "desconectado";

const listeners = new Set<(evento: EventoChat) => void>();
const estadoListeners = new Set<(estado: EstadoWs) => void>();

let socket: WebSocket | null = null;
let reconectarTimer: ReturnType<typeof setTimeout> | null = null;
let reintentos = 0;
let estado: EstadoWs = "desconectado";

function fijarEstado(nuevo: EstadoWs): void {
  estado = nuevo;
  for (const listener of estadoListeners) listener(estado);
}

export function estadoWs(): EstadoWs {
  return estado;
}

export function suscribirseWs(listener: (evento: EventoChat) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook companion: re-renders on socket state transitions. */
export function suscribirseEstadoWs(listener: (estado: EstadoWs) => void): () => void {
  estadoListeners.add(listener);
  return () => {
    estadoListeners.delete(listener);
  };
}

function urlWs(): string | null {
  const token = getAccessToken();
  if (!token) return null;
  const base = getServerUrl();
  const wsBase = base.startsWith("https://")
    ? `wss://${base.slice("https://".length)}`
    : base.replace(/^http:\/\//, "ws://");
  return `${wsBase}/ws?token=${encodeURIComponent(token)}`;
}

function programarReconexion(): void {
  if (reconectarTimer) return;
  // Exponential backoff 1s→30s; the token is re-read fresh on each attempt.
  const espera = Math.min(1000 * 2 ** reintentos, 30_000);
  reintentos += 1;
  reconectarTimer = setTimeout(() => {
    reconectarTimer = null;
    conectarWs();
  }, espera);
}

export function conectarWs(): void {
  if (socket) return;
  const url = urlWs();
  if (!url) {
    // No session yet: stay disconnected; the app calls conectarWs after login.
    fijarEstado("desconectado");
    return;
  }
  fijarEstado("conectando");
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    reintentos = 0;
    fijarEstado("conectado");
  };
  ws.onmessage = (event) => {
    try {
      const evento = JSON.parse(String(event.data)) as EventoChat | EventoPedido;
      // Pedido notifications are UI-only (toast) — never forwarded to the chat
      // listeners, which speak the chat event shape exclusively.
      if (evento.tipo === "pedido") {
        toast.success(evento.mensaje);
        return;
      }
      for (const listener of listeners) listener(evento);
    } catch {
      // Malformed frame: ignore (notifier-only contract).
    }
  };
  ws.onclose = () => {
    socket = null;
    fijarEstado("desconectado");
    programarReconexion();
  };
  ws.onerror = () => {
    // close() fires next; nothing extra here.
  };
}

export function desconectarWs(): void {
  if (reconectarTimer) {
    clearTimeout(reconectarTimer);
    reconectarTimer = null;
  }
  socket?.close();
  socket = null;
  fijarEstado("desconectado");
}
