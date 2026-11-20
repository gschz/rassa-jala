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
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { useOnline } from "@/hooks/use-online";
import { PagoModal } from "@/components/pago-modal";
import { ReciboModal } from "@/components/recibo-modal";
import { trpc } from "@/utils/trpc";

/**
 * P0 Pedidos — Admin overview: ALL orders with estado/origen filters + reasignar to an
 * active Vendedor (Q-06). Online-only screen (server procedures; orders replicate to
 * /mis-pedidos for offline reads).
 */

export const Route = createFileRoute("/pedidos-admin")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: PedidosAdminRoute,
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

type PedidoAdmin = {
  id: string;
  fkCliente: string | null;
  fkVendedor: string | null;
  estadoNombre: string;
  subtotal: string;
  iva: string;
  total: string;
  origen: string;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  clienteDisplay: string | null;
  vendedorDisplay: string | null;
  version: number;
};

function PedidosAdminRoute() {
  const session = useSession();
  if (session.user?.rol !== "Admin") {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Solo Admin</CardTitle>
            <CardDescription>Solo el rol Admin consulta todos los pedidos.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }
  return <PedidosAdminPage />;
}

function PedidosAdminPage() {
  const [estado, setEstado] = useState("");
  const [origen, setOrigen] = useState("");
  const lista = useQuery(
    trpc.pedidos.list.queryOptions({
      ...(estado ? { estado } : {}),
      ...(origen ? { origen: origen as "digital" | "presencial" } : {}),
    }),
  );
  const vendedores = useQuery(
    trpc.usuarios.list.queryOptions({ rol: "Vendedor", estado: true, pageSize: 100 }),
  );

  const isOnline = useOnline();
  const [pedidoParaPagar, setPedidoParaPagar] = useState<{ id: string; total: string } | null>(
    null,
  );
  const [reciboPedidoId, setReciboPedidoId] = useState<string | null>(null);

  const reasignar = useMutation(
    trpc.pedidos.reasignar.mutationOptions({
      onSuccess: () => {
        toast.success("Pedido reasignado");
        void lista.refetch();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const marcarEntregado = useMutation(
    trpc.pagos.marcarEntregado.mutationOptions({
      onSuccess: () => {
        toast.success("Pedido marcado como entregado");
        void lista.refetch();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const [pedidoObjetivo, setPedidoObjetivo] = useState<string | null>(null);

  return (
    <div className="container mx-auto max-w-5xl space-y-4 px-4 py-4">
      <div>
        <h1 className="text-xl font-semibold">Pedidos — Administración</h1>
        <p className="text-sm text-muted-foreground">
          Todos los pedidos con filtros y reasignación de vendedor.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={estado}
          onChange={(e) => setEstado(e.target.value)}
          className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          aria-label="Filtrar por estado"
        >
          <option value="">Todos los estados</option>
          {Object.entries(ETIQUETA_ESTADO).map(([valor, etiqueta]) => (
            <option key={valor} value={valor}>
              {etiqueta}
            </option>
          ))}
        </select>
        <select
          value={origen}
          onChange={(e) => setOrigen(e.target.value)}
          className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          aria-label="Filtrar por origen"
        >
          <option value="">Ambos orígenes</option>
          <option value="digital">Digital</option>
          <option value="presencial">Presencial</option>
        </select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void lista.refetch()}
          disabled={lista.isFetching}
        >
          Actualizar
        </Button>
      </div>

      {lista.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin" />
        </div>
      ) : lista.error ? (
        <Card>
          <CardContent className="py-6 text-sm text-red-500">{lista.error.message}</CardContent>
        </Card>
      ) : (lista.data ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">Sin pedidos.</CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {(lista.data ?? []).map((p: PedidoAdmin) => (
            <Card key={p.id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      #{p.id.slice(0, 8)} · {ETIQUETA_ESTADO[p.estadoNombre] ?? p.estadoNombre} ·{" "}
                      {p.origen === "presencial" ? "Presencial" : "Digital"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Cliente: {p.clienteDisplay ?? "—"}
                      {p.clienteTelefono ? ` (${p.clienteTelefono})` : ""} · Vendedor:{" "}
                      {p.vendedorDisplay ?? "sin asignar"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">${p.total}</span>
                    {p.estadoNombre === "pendiente" && (
                      <Button
                        size="sm"
                        disabled={!isOnline}
                        onClick={() => setPedidoParaPagar({ id: p.id, total: p.total })}
                      >
                        Registrar Pago
                      </Button>
                    )}
                    {p.estadoNombre === "confirmado" && (
                      <Button
                        size="sm"
                        disabled={!isOnline || marcarEntregado.isPending}
                        onClick={() => marcarEntregado.mutate({ fkPedido: p.id })}
                      >
                        Marcar Entregado
                      </Button>
                    )}
                    {(p.estadoNombre === "confirmado" || p.estadoNombre === "entregado") && (
                      <Button variant="outline" size="sm" onClick={() => setReciboPedidoId(p.id)}>
                        Ver Recibo
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPedidoObjetivo(pedidoObjetivo === p.id ? null : p.id)}
                    >
                      Reasignar
                    </Button>
                  </div>
                </div>
                {pedidoObjetivo === p.id && (
                  <div className="flex flex-wrap items-center gap-2 border-t pt-2">
                    <select
                      className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                      defaultValue=""
                      aria-label="Vendedor destino"
                      onChange={(e) => {
                        const fkVendedor = e.target.value;
                        if (!fkVendedor) return;
                        reasignar.mutate({ pedidoId: p.id, fkVendedor });
                        setPedidoObjetivo(null);
                      }}
                    >
                      <option value="" disabled>
                        Elegir vendedor activo…
                      </option>
                      {(vendedores.data?.usuarios ?? []).map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.nombre} {v.apellidoPaterno} ({v.correo})
                        </option>
                      ))}
                    </select>
                    {reasignar.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {pedidoParaPagar && (
        <PagoModal
          pedidoId={pedidoParaPagar.id}
          total={pedidoParaPagar.total}
          onClose={() => setPedidoParaPagar(null)}
          onSuccess={() => void lista.refetch()}
        />
      )}

      {reciboPedidoId && (
        <ReciboModal pedidoId={reciboPedidoId} onClose={() => setReciboPedidoId(null)} />
      )}
    </div>
  );
}
