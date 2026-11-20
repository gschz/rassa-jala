import { Button } from "@rassa-jala/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rassa-jala/ui/components/card";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MangoQuery } from "rxdb/plugins/core";
import { useRxQuery } from "rxdb/plugins/react";
import { toast } from "sonner";

import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { ReciboModal } from "@/components/recibo-modal";
import { type PedidoDoc, type RassaDatabase } from "@/lib/rxdb/database";
import { startReplications, type ReplicationSet } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { trpc } from "@/utils/trpc";

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
  en_preparacion: "En preparación",
  listo_para_retirar: "Listo para retirar",
  entregado: "Entregado",
  cancelado: "Cancelado",
  activo: "Activo (legacy)",
};

const COLOR_ESTADO: Record<string, string> = {
  pendiente: "text-amber-600",
  confirmado: "text-sky-600",
  en_preparacion: "text-sky-600",
  listo_para_retirar: "text-emerald-600",
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
      <div className="flex h-full items-center justify-center pt-8">
        <Loader2 className="animate-spin" />
      </div>
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
  const pedidos = useRxQuery<PedidoDoc>({ collection: db.pedidos, query: PEDIDOS_QUERY });
  const [detalleAbierto, setDetalleAbierto] = useState<string | null>(null);
  const [reciboPedidoId, setReciboPedidoId] = useState<string | null>(null);

  const cancelar = useMutation(
    trpc.pedidos.cancelar.mutationOptions({
      onSuccess: () => {
        toast.success("Pedido cancelado; el stock se restauró");
        resincronizar();
      },
      onError: (error) => toast.error(error.message),
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
    <div className="container mx-auto max-w-4xl space-y-4 px-4 py-4">
      <div>
        <h1 className="text-xl font-semibold">Mis pedidos</h1>
        <p className="text-sm text-muted-foreground">
          {session.user?.rol === "Vendedor"
            ? "Pedidos asignados a ti. Sin conexión ves lo último sincronizado."
            : "Tus pedidos. Los pendientes de confirmación aún no están confirmados por el servidor."}
        </p>
      </div>

      {pedidos.results.length === 0 ? (
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
                        #{p.id.slice(0, 8)} · {new Date(p.actualizadoEn).toLocaleString()}
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

      {detalleAbierto && docDetalle && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Pedido #{docDetalle.id.slice(0, 8)}</CardTitle>
                <CardDescription>
                  {ETIQUETA_ESTADO[docDetalle.estadoNombre] ?? docDetalle.estadoNombre} ·{" "}
                  {docDetalle.origen === "presencial" ? "Pedido presencial" : "Pedido digital"} ·
                  subtotal ${docDetalle.subtotal} + IVA ${docDetalle.iva} = ${docDetalle.total}
                </CardDescription>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setDetalleAbierto(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>
      )}

      {reciboPedidoId && (
        <ReciboModal pedidoId={reciboPedidoId} onClose={() => setReciboPedidoId(null)} />
      )}
    </div>
  );
}
