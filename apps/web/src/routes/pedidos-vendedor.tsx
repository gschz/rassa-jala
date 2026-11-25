import { Button } from "@rassa-jala/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rassa-jala/ui/components/card";
import { Input } from "@rassa-jala/ui/components/input";
import { Label } from "@rassa-jala/ui/components/label";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Minus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MangoQuery } from "rxdb/plugins/core";
import { useRxQueryLive } from "@/lib/rxdb/use-live-query";
import { toast } from "sonner";

import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { useOnline } from "@/hooks/use-online";
import { PagoModal } from "@/components/pago-modal";
import { ReciboModal } from "@/components/recibo-modal";
import { parchearPedidoLocal } from "@/lib/rxdb/pedido-local";
import {
  getDatabase,
  type ItemSemanalDoc,
  type PedidoDoc,
  type ProductoDoc,
  type RassaDatabase,
} from "@/lib/rxdb/database";
import { startReplications, type ReplicationSet } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { PageContainer } from "@/components/page-header";
import { SkeletonCards } from "@/components/skeleton";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/**
 * P0 Pedidos — Vendedor panel (Q-06): 'Disponibles' (unclaimed + pendiente, online
 * procedure + atomic claim), 'Míos' (assigned orders via the scoped PULL) and the
 * 'Pedido presencial' form (account-less person: nombre + teléfono; fk_cliente NULL,
 * NO credit, fk_vendedor auto-assigned to the creating seller).
 */

export const Route = createFileRoute("/pedidos-vendedor")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: PedidosVendedorRoute,
});

const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: "Pendiente",
  confirmado: "Confirmado",
  entregado: "Entregado",
  cancelado: "Cancelado",
  activo: "Activo",
};

const MIS_PEDIDOS_QUERY: MangoQuery<PedidoDoc> = { sort: [{ actualizadoEn: "desc" }] };
const ITEMS_QUERY: MangoQuery<ItemSemanalDoc> = { sort: [{ precio: "asc" }] };
const PRODUCTOS_QUERY: MangoQuery<ProductoDoc> = { sort: [{ nombre: "asc" }] };

/** Fire-and-forget optimistic patch (gap 2 ①): the singleton db resolves async. */
function parchearPedido(servidor: Parameters<typeof parchearPedidoLocal>[1]): void {
  getDatabase()
    .then((db) => parchearPedidoLocal(db, servidor))
    .catch((e) => console.error("[patch-pedido] fallo", e));
}

function PedidosVendedorRoute() {
  const session = useSession();
  if (session.user?.rol !== "Vendedor" && session.user?.rol !== "Admin") {
    return (
      <PageContainer>
        <Card>
          <CardHeader>
            <CardTitle>Solo Vendedor</CardTitle>
            <CardDescription>Solo los roles Vendedor (o Admin) operan este panel.</CardDescription>
          </CardHeader>
        </Card>
      </PageContainer>
    );
  }
  return <PedidosVendedorPage />;
}

function PedidosVendedorPage() {
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
  return <PanelVendedor db={db} resincronizar={resincronizar} />;
}

type Pestana = "disponibles" | "mios" | "presencial";

// Shape returned by pedidos.disponibles/claimar/cancelar (server DTO, money as strings).
type PedidoConDetalles = {
  id: string;
  folio: string;
  fkCliente: string | null;
  fkVendedor: string | null;
  estadoNombre: string;
  estado: boolean;
  subtotal: string;
  iva: string;
  total: string;
  origen: string;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  notas: string | null;
  version: number;
  actualizadoEn: string;
  detalles: Array<{
    id: string;
    fkPedido: string;
    fkProductoSemanal: string;
    nombreProducto: string;
    cantidad: number;
    precioUnitario: string;
    importe: string;
    version: number;
  }>;
};

function PanelVendedor({
  db,
  resincronizar,
}: Readonly<{ db: RassaDatabase; resincronizar: () => void }>) {
  const [pestana, setPestana] = useState<Pestana>("disponibles");
  const disponibles = useQuery(trpc.pedidos.disponibles.queryOptions());
  const pedidos = useRxQueryLive<PedidoDoc>({
    collection: db.pedidos,
    query: MIS_PEDIDOS_QUERY,
  });
  const misPedidos = pedidos.results
    .map((d) => d.toJSON() as PedidoDoc)
    .filter((p) => p.fkVendedor != null);

  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Vendedor</h1>
        <p className="text-sm text-muted-foreground">
          Reclama pedidos disponibles (un solo ganador por pedido); los presenciales quedan tuyos
          desde su creación.
        </p>
      </div>
      <div className="flex gap-2">
        {(
          [
            ["disponibles", "Disponibles"],
            ["mios", "Míos"],
            ["presencial", "Pedido presencial"],
          ] as const
        ).map(([valor, etiqueta]) => (
          <Button
            key={valor}
            variant={pestana === valor ? "default" : "outline"}
            size="sm"
            onClick={() => setPestana(valor)}
          >
            {etiqueta}
          </Button>
        ))}
      </div>

      {pestana === "disponibles" && (
        <ListaDisponibles
          filas={disponibles.data ?? []}
          cargando={disponibles.isLoading}
          error={disponibles.error?.message ?? null}
          recargar={() => void disponibles.refetch()}
          resincronizar={resincronizar}
        />
      )}
      {pestana === "mios" &&
        (pedidos.loading ? (
          <SkeletonCards count={3} />
        ) : (
          <ListaPedidos
            pedidos={misPedidos}
            titulo="Pedidos asignados a ti"
            resincronizar={resincronizar}
          />
        ))}
      {pestana === "presencial" && <FormaPresencial db={db} resincronizar={resincronizar} />}
    </PageContainer>
  );
}

function ListaDisponibles({
  filas,
  cargando,
  error,
  recargar,
  resincronizar,
}: Readonly<{
  filas: PedidoConDetalles[];
  cargando: boolean;
  error: string | null;
  recargar: () => void;
  resincronizar: () => void;
}>) {
  const claimar = useMutation(
    trpc.pedidos.claimar.mutationOptions({
      onSuccess: (data) => {
        // Optimistic patch (gap 2 ①): the claimed order flips to "Míos" locally
        // without waiting for the next PULL (server truth == patched truth).
        parchearPedido(data);
        toast.success("Pedido reclamado para ti");
        recargar();
        resincronizar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  if (cargando) {
    return <SkeletonCards count={3} />;
  }
  if (error) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-red-500">{error}</CardContent>
      </Card>
    );
  }
  if (filas.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          No hay pedidos disponibles por reclamar.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {filas.map((p) => (
        <Card key={p.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {p.folio} · {p.origen === "presencial" ? "Presencial" : "Digital"}
                {p.clienteNombre ? ` · ${p.clienteNombre}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                {p.detalles.map((d) => `${d.cantidad}× ${d.nombreProducto}`).join(", ")}
              </p>
              <p className="text-sm">Total ${p.total}</p>
            </div>
            <Button
              size="sm"
              disabled={claimar.isPending}
              onClick={() => claimar.mutate({ pedidoId: p.id })}
            >
              Reclamar
            </Button>
          </CardContent>
        </Card>
      ))}
      {claimar.isPending && <p className="text-xs text-muted-foreground">Reclamando…</p>}
      {claimar.isSuccess && <p className="text-xs text-muted-foreground">Reclamado.</p>}
    </div>
  );
}

function ListaPedidos({
  pedidos,
  titulo,
  resincronizar,
}: Readonly<{
  pedidos: PedidoDoc[];
  titulo: string;
  resincronizar: () => void;
}>) {
  const isOnline = useOnline();
  const [pedidoParaPagar, setPedidoParaPagar] = useState<{ id: string; total: string } | null>(
    null,
  );
  const [reciboPedidoId, setReciboPedidoId] = useState<string | null>(null);

  const marcarEntregado = useMutation(
    trpc.pagos.marcarEntregado.mutationOptions({
      onSuccess: (data) => {
        parchearPedido(data.pedido);
        toast.success("Pedido marcado como entregado");
        resincronizar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  if (pedidos.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          {titulo}: sin filas aún.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {pedidos.map((p) => {
        const esPendiente = p.estadoNombre === "pendiente";
        const esConfirmado = p.estadoNombre === "confirmado";
        const tieneRecibo = p.estadoNombre === "confirmado" || p.estadoNombre === "entregado";

        return (
          <Card key={p.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
              <div>
                <p className="text-sm font-medium">
                  {p.folio ?? `#${p.id.slice(0, 8)}`} ·{" "}
                  {ETIQUETA_ESTADO[p.estadoNombre] ?? p.estadoNombre}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.origen === "presencial"
                    ? `Presencial${p.clienteNombre ? ` · ${p.clienteNombre}` : ""}`
                    : `Digital${p.fkCliente ? ` · cliente ${p.fkCliente.slice(0, 8)}` : ""}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">${p.total}</span>
                {esPendiente && (
                  <Button
                    size="sm"
                    disabled={!isOnline}
                    onClick={() => setPedidoParaPagar({ id: p.id, total: p.total })}
                  >
                    Registrar Pago
                  </Button>
                )}
                {esConfirmado && (
                  <Button
                    size="sm"
                    disabled={!isOnline || marcarEntregado.isPending}
                    onClick={() => marcarEntregado.mutate({ fkPedido: p.id })}
                  >
                    Marcar Entregado
                  </Button>
                )}
                {tieneRecibo && (
                  <Button variant="outline" size="sm" onClick={() => setReciboPedidoId(p.id)}>
                    Ver Recibo
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {pedidoParaPagar && (
        <PagoModal
          pedidoId={pedidoParaPagar.id}
          total={pedidoParaPagar.total}
          onClose={() => setPedidoParaPagar(null)}
          onSuccess={() => resincronizar()}
        />
      )}

      {reciboPedidoId && (
        <ReciboModal pedidoId={reciboPedidoId} onClose={() => setReciboPedidoId(null)} />
      )}
    </div>
  );
}

// In-person order form: pick weekly offers + quantities; nombre required, teléfono opcional.
function FormaPresencial({
  db,
  resincronizar,
}: Readonly<{ db: RassaDatabase; resincronizar: () => void }>) {
  const items = useRxQueryLive<ItemSemanalDoc>({
    collection: db.itemsSemanales,
    query: ITEMS_QUERY,
  });
  const productos = useRxQueryLive<ProductoDoc>({
    collection: db.productos,
    query: PRODUCTOS_QUERY,
  });
  const nombreProducto = new Map(
    productos.results.map((d) => d.toJSON() as ProductoDoc).map((p) => [p.id, p.nombre] as const),
  );
  const ofertas = items.results
    .map((d) => d.toJSON() as ItemSemanalDoc)
    .filter((i) => i.estado === "activo" && i.stock > 0);

  const [clienteNombre, setClienteNombre] = useState("");
  const [clienteTelefono, setClienteTelefono] = useState("");
  const [lineas, setLineas] = useState<
    Array<{ fkProductoSemanal: string; cantidad: number; stock: number }>
  >([]);

  const pedidoPresencial = useMutation(
    trpc.pedidos.pedidoPresencial.mutationOptions({
      onSuccess: (data) => {
        // The in-person order is vendedor-owned from creation: it appears in "Míos"
        // immediately (no PULL wait).
        parchearPedido(data);
        toast.success("Pedido presencial creado (asignado a ti, sin consumo de crédito)");
        setLineas([]);
        setClienteNombre("");
        setClienteTelefono("");
        resincronizar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  const fijarCantidad = (fkProductoSemanal: string, stock: number, cantidad: number): void => {
    setLineas((prev) => {
      if (cantidad <= 0) return prev.filter((l) => l.fkProductoSemanal !== fkProductoSemanal);
      const existe = prev.some((l) => l.fkProductoSemanal === fkProductoSemanal);
      const nueva = Math.min(cantidad, stock);
      return existe
        ? prev.map((l) =>
            l.fkProductoSemanal === fkProductoSemanal ? { ...l, cantidad: nueva } : l,
          )
        : [...prev, { fkProductoSemanal, cantidad: nueva, stock }];
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pedido presencial</CardTitle>
        <CardDescription>
          Cliente sin cuenta (clientes físicos): no consume crédito; el stock y los montos los
          valida el servidor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="nombre-fisico">Nombre del cliente</Label>
            <Input
              id="nombre-fisico"
              value={clienteNombre}
              onChange={(e) => setClienteNombre(e.target.value)}
              placeholder="Nombre y apellido"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="telefono-fisico">Teléfono (opcional)</Label>
            <Input
              id="telefono-fisico"
              value={clienteTelefono}
              onChange={(e) => setClienteTelefono(e.target.value)}
              placeholder="311 000 0000"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label>Artículos</Label>
          {ofertas.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin ofertas sincronizadas con stock.</p>
          ) : (
            <div className="space-y-1">
              {ofertas.map((item) => {
                const linea = lineas.find((l) => l.fkProductoSemanal === item.id);
                return (
                  <div key={item.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex-1 truncate">
                      {nombreProducto.get(item.fkProducto) ?? item.fkProducto} — ${item.precio}{" "}
                      (stock {item.stock})
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        aria-label="Quitar uno"
                        onClick={() =>
                          fijarCantidad(item.id, item.stock, (linea?.cantidad ?? 0) - 1)
                        }
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="w-8 text-center">{linea?.cantidad ?? 0}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        aria-label="Agregar uno"
                        onClick={() =>
                          fijarCantidad(item.id, item.stock, (linea?.cantidad ?? 0) + 1)
                        }
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                      {linea && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label="Quitar línea"
                          onClick={() => fijarCantidad(item.id, item.stock, 0)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <Button
          disabled={
            lineas.length === 0 || clienteNombre.trim().length === 0 || pedidoPresencial.isPending
          }
          onClick={() =>
            pedidoPresencial.mutate({
              clienteNombre: clienteNombre.trim(),
              ...(clienteTelefono.trim() ? { clienteTelefono: clienteTelefono.trim() } : {}),
              items: lineas.map((l) => ({
                fkProductoSemanal: l.fkProductoSemanal,
                cantidad: l.cantidad,
              })),
            })
          }
        >
          {pedidoPresencial.isPending ? "Registrando…" : "Registrar pedido presencial"}
        </Button>
      </CardContent>
    </Card>
  );
}
