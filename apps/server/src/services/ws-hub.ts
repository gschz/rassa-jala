import type { EventoChat, EventoPedido, NotificadorChat } from "@rassa-jala/api/context";
import type { ServerWebSocket } from "bun";

// P1-D Chat WS hub (user decision 2026-11-20: Bun WS = NOTIFIER ONLY, never
// transport — the S3 replication stays the source of truth; polling 30–60 s is the
// fallback). In-memory registry: authenticated user id → live sockets. The chat
// router publishes through `notificador` (injected via Context like the storage
// driver); the hub fans the event out to every socket of the target users. This
// module is a process singleton — the registry dies with the server process, which
// is acceptable because the notifier carries no state (clients re-pull on reconnect
// and the 45 s query polling covers missed events).
//
// Presence/typing realtime is P2 and is NOT built here (spec boundary).

const conexiones = new Map<string, Set<ServerWebSocket<Record<string, unknown>>>>();

export function registrarSocket(
  idUsuario: string,
  ws: ServerWebSocket<Record<string, unknown>>,
): void {
  const set = conexiones.get(idUsuario) ?? new Set();
  set.add(ws);
  conexiones.set(idUsuario, set);
}

export function quitarSocket(
  idUsuario: string,
  ws: ServerWebSocket<Record<string, unknown>>,
): void {
  const set = conexiones.get(idUsuario);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) conexiones.delete(idUsuario);
}

const notificador: NotificadorChat = {
  publicar(destinatarios, evento: EventoChat | EventoPedido): void {
    const payload = JSON.stringify(evento);
    for (const id of destinatarios) {
      for (const ws of conexiones.get(id) ?? []) {
        try {
          ws.send(payload);
        } catch {
          // Dead socket: close() removes it from the registry; the client's
          // reconnect/backoff + query polling cover the missed event.
        }
      }
    }
  },
};

export const hub = { notificador };
