import { Badge } from "@rassa-jala/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rassa-jala/ui/components/tooltip";
import { cn } from "@rassa-jala/ui/lib/utils";

import { useOnline } from "@/hooks/use-online";
import { useSyncStatus, type SyncStatusState } from "@/lib/rxdb/sync-status";

/**
 * Compact sync indicator (doc §9). Five states only — no checkpoints,
 * sequences or outbox internals. Pending operations are NEVER presented
 * as confirmed.
 */
const ESTADO_SYNC = {
  online: { label: "En línea", dot: "bg-success" },
  syncing: { label: "Sincronizando", dot: "bg-info animate-pulse" },
  offline: { label: "Sin conexión", dot: "bg-destructive" },
  pending: { label: "Pendiente", dot: "bg-warning" },
  attention: { label: "Requiere atención", dot: "bg-destructive" },
} as const;

type EstadoSyncClave = keyof typeof ESTADO_SYNC;

export function estadoSyncDe(online: boolean, status: SyncStatusState): EstadoSyncClave {
  const colecciones = Object.values(status.collections);
  if (!online) return "offline";
  if (colecciones.some((c) => c.error != null)) return "attention";
  if (colecciones.some((c) => c.syncing)) return "syncing";
  if (status.pendingLocalidadIds.length > 0) return "pending";
  return "online";
}

function detalleTooltip(clave: EstadoSyncClave, status: SyncStatusState): string {
  const pendientes = status.pendingLocalidadIds.length;
  const conError = Object.entries(status.collections)
    .filter(([, c]) => c.error != null)
    .map(([nombre]) => nombre);
  if (clave === "offline") return "Sin conexión con el servidor; los cambios locales se conservan.";
  if (clave === "attention") return `Error de sincronización en: ${conError.join(", ")}.`;
  if (clave === "syncing") return "Sincronizando datos con el servidor…";
  if (clave === "pending") {
    return `${pendientes} operación${pendientes > 1 ? "es" : ""} pendiente${pendientes > 1 ? "s" : ""} de confirmar por el servidor.`;
  }
  return "Todo sincronizado con el servidor.";
}

export function SyncIndicator({ className }: Readonly<{ className?: string }>) {
  const status = useSyncStatus();
  const online = useOnline();
  const clave = estadoSyncDe(online, status);
  const estado = ESTADO_SYNC[clave];

  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex" />}>
        <Badge
          variant="outline"
          className={cn("h-9 gap-2 px-3 text-xs rounded-lg font-medium", className)}
        >
          <span className={cn("size-2 shrink-0 rounded-full", estado.dot)} aria-hidden />
          {estado.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span>{detalleTooltip(clave, status)}</span>
      </TooltipContent>
    </Tooltip>
  );
}
