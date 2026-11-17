import { Card, CardContent } from "@rassa-jala/ui/components/card";

import { type ColeccionSyncStatus, type SyncStatusState } from "@/lib/rxdb/sync-status";

export interface SyncStatusBadge {
  label: string;
  color: string;
}

export function getSyncStatusBadge(estado: ColeccionSyncStatus): SyncStatusBadge {
  if (estado.error) {
    return { label: "Error", color: "text-red-500" };
  }
  if (estado.syncing) {
    return { label: "Sincronizando…", color: "text-blue-500" };
  }
  if (estado.lastSyncAt != null) {
    return {
      label: `OK ${new Date(estado.lastSyncAt).toLocaleTimeString()}`,
      color: "text-emerald-500",
    };
  }
  return { label: "Sin sincronizar", color: "text-muted-foreground" };
}

export function ChipEstado({
  coleccion,
  estado,
}: Readonly<{
  coleccion: string;
  estado: ColeccionSyncStatus;
}>) {
  const { label, color } = getSyncStatusBadge(estado);
  return (
    <span className={`text-xs ${color}`}>
      {coleccion}: {label}
      {estado.checkpoint != null ? ` · seq ${estado.checkpoint}` : ""}
    </span>
  );
}

export function EstadoSincronizacion({
  online,
  status,
}: Readonly<{
  online: boolean;
  status: SyncStatusState;
}>) {
  const pendientes = status.pendingLocalidadIds.length;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-sm">
          <span
            className={`h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-red-500"}`}
            aria-hidden
          />
          {online ? "En línea" : "Sin conexión"}
        </span>
        <span className="text-muted-foreground" aria-hidden>
          |
        </span>
        {Object.entries(status.collections).map(([coleccion, estado]) => (
          <ChipEstado key={coleccion} coleccion={coleccion} estado={estado} />
        ))}
        {pendientes > 0 && (
          <span className="text-xs font-medium text-amber-500">
            {pendientes} operación{pendientes > 1 ? "es" : ""} pendiente
            {pendientes > 1 ? "s" : ""} de sincronizar
          </span>
        )}
      </CardContent>
    </Card>
  );
}
