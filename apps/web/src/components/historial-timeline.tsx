import { Loader2 } from "lucide-react";

/**
 * P1-F: shared state-log timeline (historial_estado_pedido /
 * historial_estado_recoleccion rows via historiales.*). Legacy OrderTimeline
 * concepts: chronological dot rows with "estado anterior → estado nuevo",
 * timestamp and the actor's resolved name; presentational only — the callers
 * own the data fetching.
 */

export type HistorialFilaView = {
  id: string;
  estadoAnterior: string | null;
  estadoNuevo: string;
  actor: string | null;
  fecha: string;
};

export function HistorialTimeline({
  cargando,
  error,
  filas,
}: Readonly<{ cargando: boolean; error: string | null; filas: HistorialFilaView[] }>) {
  if (cargando) {
    return (
      <div className="flex justify-center py-3">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (error) {
    return <p className="py-1 text-sm text-red-500">{error}</p>;
  }
  if (filas.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin historial de cambios.</p>;
  }
  return (
    <ol className="space-y-2">
      {filas.map((h) => (
        <li key={h.id} className="flex items-start gap-2 text-sm">
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
          <div>
            <p>
              {h.estadoAnterior ? `${h.estadoAnterior} → ` : ""}
              <span className="font-medium">{h.estadoNuevo}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {new Date(h.fecha).toLocaleString()}
              {h.actor ? ` · ${h.actor}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
