import { Button } from "@rassa-jala/ui/components/button";
import { Card, CardContent } from "@rassa-jala/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@rassa-jala/ui/components/dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MangoQuery } from "rxdb/plugins/core";
import { useRxQueryLive } from "@/lib/rxdb/use-live-query";
import { toast } from "sonner";

import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { ReciboModal } from "@/components/recibo-modal";
import { getDatabase, type PedidoDoc, type RassaDatabase } from "@/lib/rxdb/database";
import { parchearPedidoLocal } from "@/lib/rxdb/pedido-local";
import { startReplications, type ReplicationSet } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { PageContainer } from "@/components/page-header";
import { SkeletonCards } from "@/components/skeleton";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/** Fire-and-forget optimistic patch (gap 2 ①): the singleton db resolves async. */
function parchearPedido(servidor: Parameters<typeof parchearPedidoLocal>[1]): void {
  getDatabase()
    .then((db) => parchearPedidoLocal(db, servidor))
    .catch((e) => console.error("[patch-pedido] fallo", e));
}

/**
 * P0 Pedidos — "Mis pedidos": client orders list + detail (items EMBEDDED in the pulled
 * pedido doc, historial timeline from the server-side detail procedure).
 *
 * Offline rule (scope.md §6): a queued order (doc.syncOpId present) shows
 * "Pendiente de confirmación" and is NEVER presented as confirmed. Vendedores also land
 * here (their ASSIGNED orders); Admin sees all.
 */

export const Route = createFileRoute("/mis-pedidos")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: MisPedidosRoute,
});

const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: "Pendiente",
  confirmado: "Confirmado",
  entregado: "Entregado",
  cancelado: "Cancelado",
  activo: "Activo",
};

const COLOR_ESTADO: Record<string, string> = {
  pendiente: "text-amber-600",
  confirmado: "text-sky-600",
  entregado: "text-emerald-600",
  cancelado: "text-red-500",
};

const PEDIDOS_QUERY: MangoQuery<PedidoDoc> = {
  sort: [{ actualizadoEn: "desc" }, { id: "asc" }],
};

function MisPedidosRoute() {
  const db = useDatabase();
  const repRef = useRef<ReplicationSet | null>(null);

  useEffect(() => {
    if (!db) return;
    const replications = startReplications(db);
    repRef.current = replications;
    return () => {
      void replications.stop();
      repRef.current = null;
    };
  }, [db]);

  if (!db) {
    return (
      <PageContainer>
        {/* Skeleton while the local database spins up (initial load). */}
        <SkeletonCards count={3} />
      </PageContainer>
    );
  }
  const resincronizar = (): void => {
    repRef.current?.reSyncAll();
  };
  return <PaginaMisPedidos db={db} resincronizar={resincronizar} />;
}

function PaginaMisPedidos({
  db,
  resincronizar,
}: Readonly<{ db: RassaDatabase; resincronizar: () => void }>) {
  const session = useSession();
  const pedidos = useRxQueryLive<PedidoDoc>({
    collection: db.pedidos,
    query: PEDIDOS_QUERY,
  });
  const [detalleAbierto, setDetalleAbierto] = useState<string | null>(null);
  const [reciboPedidoId, setReciboPedidoId] = useState<string | null>(null);

  const cancelar = useMutation(
    trpc.pedidos.cancelar.mutationOptions({
      onSuccess: (data) => {
        // Optimistic patch (gap 2 ①): the cancellation is visible locally without
        // waiting for the next PULL (server truth == patched truth).
        parchearPedido(data);
        toast.success("Pedido cancelado; el stock se restauró");
        resincronizar();
      },
      onError: (error) => notificarError(error),
    }),
  );
  const detalleServidor = useQuery({
    ...trpc.pedidos.detalle.queryOptions({ id: detalleAbierto ?? "" }),
    enabled: detalleAbierto !== null,
  });

  const docDetalle = detalleAbierto
    ? pedidos.results.map((d) => d.toJSON() as PedidoDoc).find((p) => p.id === detalleAbierto)
    : undefined;
  // The lines ride EMBEDDED in the pulled pedido doc (§6.2 one-collection grain).
  const itemsDetalle = docDetalle?.detalles ?? [];
  const historial = detalleServidor.data?.historial ?? [];
  const puedeCancelar = (p: PedidoDoc): boolean => {
    const rol = session.user?.rol;
    const id = session.user?.id;
    if (!rol || !id) return false;
    if (p.syncOpId !== undefined || p.estadoNombre !== "pendiente") return false;
    if (rol === "Admin") return true;
    if (rol === "Vendedor") return p.fkVendedor === id;
    return p.fkCliente === id;
  };

  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Mis pedidos</h1>
        <p className="text-sm text-muted-foreground">
          {session.user?.rol === "Vendedor"
            ? "Pedidos asignados a ti. Sin conexión ves lo último sincronizado."
            : "Tus pedidos. Los pendientes de confirmación aún no están confirmados por el servidor."}
        </p>
      </div>

      {pedidos.loading ? (
        <SkeletonCards count={3} />
      ) : pedidos.results.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Aún no tienes pedidos. Haz uno desde el Catálogo.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {pedidos.results.map((doc) => {
            const p = doc.toJSON() as PedidoDoc;
            const enCola = p.syncOpId !== undefined;
            return (
              <Card key={p.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${COLOR_ESTADO[p.estadoNombre] ?? ""}`}>
                        {enCola
                          ? "Pendiente de confirmación"
                          : (ETIQUETA_ESTADO[p.estadoNombre] ?? p.estadoNombre)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {enCola
                          ? `#${p.id.slice(0, 8)} · ${new Date(p.actualizadoEn).toLocaleString()}`
                          : `${p.folio ?? `#${p.id.slice(0, 8)}`} · ${new Date(p.actualizadoEn).toLocaleString()}`}
                      </span>
                    </div>
                    <p className="text-sm">
                      Total <span className="font-semibold">${p.total}</span>
                      {enCola && " (estimado en cola)"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setDetalleAbierto(p.id)}>
                      Detalle
                    </Button>
                    {(p.estadoNombre === "confirmado" || p.estadoNombre === "entregado") && (
                      <Button variant="outline" size="sm" onClick={() => setReciboPedidoId(p.id)}>
                        Ver Recibo
                      </Button>
                    )}
                    {puedeCancelar(p) && (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={cancelar.isPending}
                        onClick={() => cancelar.mutate({ pedidoId: p.id, version: p.version })}
                      >
                        <X className="h-4 w-4" /> Cancelar
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={detalleAbierto !== null && docDetalle !== undefined}
        onOpenChange={(open) => {
          if (!open) setDetalleAbierto(null);
        }}
      >
        {detalleAbierto && docDetalle && (
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{docDetalle.folio ?? `#${docDetalle.id.slice(0, 8)}`}</DialogTitle>
              <DialogDescription>
                {ETIQUETA_ESTADO[docDetalle.estadoNombre] ?? docDetalle.estadoNombre} ·{" "}
                {docDetalle.origen === "presencial" ? "Pedido presencial" : "Pedido digital"} ·
                subtotal ${docDetalle.subtotal} + IVA ${docDetalle.iva} = ${docDetalle.total}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1 text-sm">
                <p className="font-medium">Artículos</p>
                {itemsDetalle.length === 0 ? (
                  <p className="text-muted-foreground">
                    {docDetalle.items && docDetalle.items.length > 0
                      ? "En cola: los artículos viajan con el pedido al sincronizar."
                      : "Sin artículos sincronizados todavía."}
                  </p>
                ) : (
                  itemsDetalle.map((d) => (
                    <p key={d.id}>
                      {d.cantidad} × {d.nombreProducto} — ${d.precioUnitario} c/u = ${d.importe}
                    </p>
                  ))
                )}
              </div>
              <div className="space-y-1 text-sm">
                <p className="font-medium">Historial de estados</p>
                {detalleServidor.isLoading ? (
                  <p className="text-muted-foreground">Cargando historial…</p>
                ) : historial.length === 0 ? (
                  <p className="text-muted-foreground">
                    El historial se consulta en línea (bitácora del servidor).
                  </p>
                ) : (
                  <ol className="space-y-1">
                    {historial.map((h) => (
                      <li key={h.id} className="flex gap-2">
                        <span className="text-muted-foreground">
                          {new Date(h.fecha).toLocaleString()}
                        </span>
                        <span className="font-medium">
                          {ETIQUETA_ESTADO[h.estadoNombre] ?? h.estadoNombre}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>

      {reciboPedidoId && (
        <ReciboModal pedidoId={reciboPedidoId} onClose={() => setReciboPedidoId(null)} />
      )}
    </PageContainer>
  );
}
