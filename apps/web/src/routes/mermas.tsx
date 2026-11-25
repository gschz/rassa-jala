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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rassa-jala/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rassa-jala/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { PackageMinus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { PageContainer, PageHeader } from "@/components/page-header";
import { SkeletonTable } from "@/components/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/http";
import { useOnline } from "@/hooks/use-online";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

type ResumenMermasDto = {
  agrupacion: string;
  totalGeneral: number;
  productoMasAfectado: { nombre: string; total: number } | null;
  detalle: Array<{
    periodo: string;
    productoNombre: string;
    productoId: string;
    decisionNombre: string;
    decisionId: string;
    totalCantidad: number;
    totalMermas: number;
  }>;
};

/**
 * P1-C Mermas (docs/roadmap.md §6 P1-C; docs/database.md §6.2 M-17). Design system
 * compositions (PageHeader + StatusBadge + EmptyState + LoadingState + ConfirmDialog
 * + Table), semantic tokens only, Spanish copy.
 *
 * ONLINE-CONFIRM lane (COL23 — no RxDB collection, M-17): everything is
 * server-fetched via TanStack Query and gated on connectivity. Roles (legacy
 * HasRole(ADMIN, VENDEDOR) parity): the Vendedor sees only mermas of his own
 * pedidos; Agricultor/Cliente see an access-denied state (the server 403s too).
 *
 * The stock decrement happens server-side AT registration (legacy create parity,
 * row-locked) — the client never edits stock and there is no edit/delete lane for
 * a registered merma (append-only, legacy parity).
 */

export const Route = createFileRoute("/mermas")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: MermasRoute,
});

type MermaDto = {
  id: string;
  fkPedido: string;
  cantidad: number;
  motivo: string;
  comentarios: string | null;
  creadoEn: string;
  estado: boolean;
  productoInfo: { id: string; producto: string; stockRestante: number } | null;
  decisionInfo: { id: string; nombre: string } | null;
  pedidoInfo: {
    id: string;
    folio: string | null;
    cliente: string | null;
    estado: string | null;
    total: string;
  } | null;
};

type DecisionDto = { id: string; decision: string; estado: boolean };

type PedidoDto = {
  id: string;
  folio: string;
  estadoNombre: string;
  clienteNombre: string | null;
  detalles: Array<{ fkProductoSemanal: string; nombreProducto: string; cantidad: number }>;
};

function MermasRoute() {
  const session = useSession();
  if (session.user?.rol !== "Admin" && session.user?.rol !== "Vendedor") {
    return (
      <PageContainer>
        <EmptyState
          icon={<PackageMinus />}
          title="Sin acceso"
          description="Solo Vendedor o Admin consultan mermas."
        />
      </PageContainer>
    );
  }
  return <MermasPage />;
}

function MermasPage() {
  const esAdmin = useSession().user?.rol === "Admin";
  const isOnline = useOnline();
  const listado = useQuery(trpc.mermas.listar.queryOptions(undefined));
  const recargar = (): void => void listado.refetch();

  return (
    <PageContainer>
      <PageHeader
        title="Mermas"
        description="Registro de pérdidas sobre los pedidos entregados: el stock del producto semanal se descuenta al registrar y una merma registrada no se edita ni se borra."
      />

      <FormaRegistrar esAdmin={esAdmin} isOnline={isOnline} recargar={recargar} />

      {esAdmin && <GestionDecisiones isOnline={isOnline} />}

      {esAdmin && <ResumenMermas isOnline={isOnline} />}

      <ListaMermas
        filas={listado.data ?? []}
        cargando={listado.isLoading}
        error={listado.error?.message ?? null}
        isOnline={isOnline}
        recargar={recargar}
      />
    </PageContainer>
  );
}

/** Pedidos available to the caller for the form: Vendedor → own, Admin → all. */
function usePedidosParaForma(esAdmin: boolean, isOnline: boolean) {
  const propios = useQuery(trpc.pedidos.misPedidos.queryOptions(undefined, { enabled: isOnline }));
  const todos = useQuery(
    trpc.pedidos.list.queryOptions(undefined, { enabled: isOnline && esAdmin }),
  );
  return esAdmin ? (todos.data ?? []) : (propios.data ?? []);
}

function FormaRegistrar({
  esAdmin,
  isOnline,
  recargar,
}: Readonly<{ esAdmin: boolean; isOnline: boolean; recargar: () => void }>) {
  const [fkPedido, setFkPedido] = useState("");
  const [fkProductoSemanal, setFkProductoSemanal] = useState("");
  const [cantidad, setCantidad] = useState("1");
  const [motivo, setMotivo] = useState("");
  const [comentarios, setComentarios] = useState("");
  const [fkDecision, setFkDecision] = useState("");
  const [confirmar, setConfirmar] = useState(false);

  const pedidos = usePedidosParaForma(esAdmin, isOnline);
  const decisiones = useQuery(
    trpc.mermas.decisiones.listar.queryOptions(undefined, { enabled: isOnline }),
  );
  const queryClient = useQueryClient();

  const registrar = useMutation(
    trpc.mermas.registrar.mutationOptions({
      onSuccess: () => {
        toast.success("Merma registrada");
        setFkPedido("");
        setFkProductoSemanal("");
        setCantidad("1");
        setMotivo("");
        setComentarios("");
        setFkDecision("");
        void queryClient.invalidateQueries({ queryKey: trpc.pedidos.misPedidos.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.pedidos.list.queryKey() });
        recargar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  const pedidoElegido = pedidos.find((p: PedidoDto) => p.id === fkPedido);
  const cantidadValida = /^\d{1,6}$/.test(cantidad) && Number(cantidad) >= 1;
  const puedoEnviar =
    isOnline &&
    fkPedido !== "" &&
    fkProductoSemanal !== "" &&
    fkDecision !== "" &&
    cantidadValida &&
    motivo.trim() !== "" &&
    !registrar.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Registrar merma</CardTitle>
        <CardDescription>
          {isOnline
            ? "El servidor valida que el producto pertenezca al pedido, descuenta el stock al registrar y congela el registro; la operación no se puede revertir."
            : "Sin conexión: registrar una merma requiere confirmación del servidor."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="merma-pedido">Pedido</Label>
            <Select
              value={fkPedido}
              onValueChange={(valor) => {
                setFkPedido(valor == null ? "" : String(valor));
                setFkProductoSemanal("");
              }}
            >
              <SelectTrigger id="merma-pedido" className="w-full">
                <SelectValue placeholder="Selecciona un pedido" />
              </SelectTrigger>
              <SelectContent>
                {pedidos.map((p: PedidoDto) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.folio} — {p.clienteNombre ?? "Cliente físico"} ({p.estadoNombre})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="merma-producto">Producto del pedido</Label>
            <Select
              value={fkProductoSemanal}
              onValueChange={(valor) => setFkProductoSemanal(valor == null ? "" : String(valor))}
            >
              <SelectTrigger id="merma-producto" className="w-full">
                <SelectValue placeholder="Selecciona un producto" />
              </SelectTrigger>
              <SelectContent>
                {(pedidoElegido?.detalles ?? []).map((d) => (
                  <SelectItem key={d.fkProductoSemanal} value={d.fkProductoSemanal}>
                    {d.nombreProducto} (×{d.cantidad})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="merma-cantidad">Cantidad</Label>
            <Input
              id="merma-cantidad"
              inputMode="numeric"
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="merma-decision">Decisión</Label>
            <Select
              value={fkDecision}
              onValueChange={(valor) => setFkDecision(valor == null ? "" : String(valor))}
            >
              <SelectTrigger id="merma-decision" className="w-full">
                <SelectValue placeholder="¿Qué se hará con la pérdida?" />
              </SelectTrigger>
              <SelectContent>
                {(decisiones.data ?? []).map((d: DecisionDto) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.decision}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="merma-motivo">Motivo</Label>
            <Input
              id="merma-motivo"
              value={motivo}
              maxLength={300}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="merma-comentarios">Comentarios (opcional)</Label>
            <Input
              id="merma-comentarios"
              value={comentarios}
              maxLength={2000}
              onChange={(e) => setComentarios(e.target.value)}
            />
          </div>
        </div>
        <Button disabled={!puedoEnviar} onClick={() => setConfirmar(true)}>
          {registrar.isPending ? "Registrando…" : "Registrar merma"}
        </Button>
        <ConfirmDialog
          open={confirmar}
          onOpenChange={setConfirmar}
          title="¿Registrar la merma?"
          description="El servidor descontará el stock del producto semanal al confirmar; el registro queda congelado sin edición ni borrado."
          confirmLabel="Registrar"
          onConfirm={() =>
            registrar.mutate({
              fkPedido,
              fkProductoSemanal,
              cantidad: Number(cantidad),
              motivo: motivo.trim(),
              comentarios: comentarios.trim() === "" ? undefined : comentarios,
              fkDecision,
              operationId: crypto.randomUUID(),
            })
          }
        />
      </CardContent>
    </Card>
  );
}

/** Gap 18 closure: legacy MermaResumenView (Admin-only analytics) — grouped by
 * period (mes|semana), product and decision, with the global top product. */
function ResumenMermas({ isOnline }: Readonly<{ isOnline: boolean }>) {
  const [agruparPor, setAgruparPor] = useState<"mes" | "semana">("mes");
  const resumen = useQuery(
    trpc.historiales.resumenMermas.queryOptions({ agruparPor }, { enabled: isOnline }),
  );

  if (resumen.isLoading) {
    return <SkeletonTable rows={5} />;
  }
  if (resumen.error) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">{resumen.error.message}</CardContent>
      </Card>
    );
  }
  const r = resumen.data as ResumenMermasDto | undefined;
  if (!r) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Resumen de mermas</CardTitle>
            <CardDescription>
              Agregado por período, producto y decisión. Total del período: {r.totalGeneral}
              {r.productoMasAfectado
                ? ` · Producto más afectado: ${r.productoMasAfectado.nombre} (${r.productoMasAfectado.total})`
                : ""}
            </CardDescription>
          </div>
          <select
            value={agruparPor}
            onChange={(e) => setAgruparPor(e.target.value === "semana" ? "semana" : "mes")}
            className="flex h-10 rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
            aria-label="Agrupar por"
          >
            <option value="mes">Por mes</option>
            <option value="semana">Por semana</option>
          </select>
        </div>
      </CardHeader>
      <CardContent>
        {r.detalle.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin mermas registradas en el período.</p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Período</TableHead>
                  <TableHead>Producto</TableHead>
                  <TableHead>Decisión</TableHead>
                  <TableHead className="text-right">Cantidad total</TableHead>
                  <TableHead className="text-right">Mermas</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.detalle.map((g) => (
                  <TableRow key={`${g.periodo}|${g.productoId}|${g.decisionId}`}>
                    <TableCell>{formatPeriodo(g.periodo, r.agrupacion)}</TableCell>
                    <TableCell className="font-medium">{g.productoNombre}</TableCell>
                    <TableCell>{g.decisionNombre}</TableCell>
                    <TableCell className="text-right">{g.totalCantidad}</TableCell>
                    <TableCell className="text-right">{g.totalMermas}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Periodo string (week Monday / month start) → friendly Spanish label. */
function formatPeriodo(periodo: string, agrupacion: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodo)) return periodo;
  const fecha = new Date(`${periodo}T00:00:00.000Z`);
  return agrupacion === "semana"
    ? `Semana del ${periodo}`
    : fecha.toLocaleDateString("es-MX", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Legacy DecisionMermaViewSet parity (Admin-only): create / rename / soft-delete. */ function GestionDecisiones({
  isOnline,
}: Readonly<{ isOnline: boolean }>) {
  const [nueva, setNueva] = useState("");
  const [porDesactivar, setPorDesactivar] = useState<DecisionDto | null>(null);
  const listado = useQuery(trpc.mermas.decisiones.listar.queryOptions(undefined));
  const queryClient = useQueryClient();

  const crear = useMutation(
    trpc.mermas.decisiones.crear.mutationOptions({
      onSuccess: () => {
        toast.success("Decisión registrada correctamente.");
        setNueva("");
        void queryClient.invalidateQueries({ queryKey: trpc.mermas.decisiones.listar.queryKey() });
      },
      onError: (error) => notificarError(error),
    }),
  );
  const desactivar = useMutation(
    trpc.mermas.decisiones.desactivar.mutationOptions({
      onSuccess: () => {
        toast.success("Decisión desactivada");
        setPorDesactivar(null);
        void queryClient.invalidateQueries({ queryKey: trpc.mermas.decisiones.listar.queryKey() });
      },
      onError: (error) => notificarError(error),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decisiones de merma</CardTitle>
        <CardDescription>
          Catálogo del Admin: una decisión desactivada deja de aceptarse en registros nuevos; las
          mermas ya registradas conservan su decisión.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            id="merma-decision-nueva"
            placeholder="Nueva decisión (máx. 50 caracteres)"
            value={nueva}
            maxLength={50}
            onChange={(e) => setNueva(e.target.value)}
            className="max-w-xs"
          />
          <Button
            variant="outline"
            disabled={!isOnline || nueva.trim() === "" || crear.isPending}
            onClick={() => crear.mutate({ decision: nueva.trim() })}
          >
            {crear.isPending ? "Agregando…" : "Agregar"}
          </Button>
        </div>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Decisión</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(listado.data ?? []).map((d: DecisionDto) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.decision}</TableCell>
                  <TableCell>
                    <StatusBadge tone={d.estado ? "ok" : "neutral"}>
                      {d.estado ? "Activa" : "Inactiva"}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-right">
                    {d.estado && (
                      <Button size="sm" variant="outline" onClick={() => setPorDesactivar(d)}>
                        <Trash2 className="size-4" /> Desactivar
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <ConfirmDialog
          open={porDesactivar !== null}
          onOpenChange={(abierto) => !abierto && setPorDesactivar(null)}
          title={`¿Desactivar la decisión "${porDesactivar?.decision ?? ""}"?`}
          description="El catálogo solo se desactiva; no se elimina."
          confirmLabel="Desactivar"
          onConfirm={() => porDesactivar && desactivar.mutate({ id: porDesactivar.id })}
        />
      </CardContent>
    </Card>
  );
}

function ListaMermas({
  filas,
  cargando,
  error,
  isOnline,
  recargar,
}: Readonly<{
  filas: MermaDto[];
  cargando: boolean;
  error: string | null;
  isOnline: boolean;
  recargar: () => void;
}>) {
  if (cargando) {
    return <SkeletonTable rows={5} />;
  }
  if (error) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">{error}</CardContent>
      </Card>
    );
  }
  if (filas.length === 0) {
    return (
      <EmptyState
        icon={<PackageMinus />}
        title="Sin mermas"
        description={
          isOnline
            ? "Registra la primera merma de un pedido entregado."
            : "Las mermas se consultan en línea; revisa tu conexión."
        }
      >
        {isOnline && (
          <Button variant="outline" onClick={recargar}>
            Actualizar
          </Button>
        )}
      </EmptyState>
    );
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fecha</TableHead>
            <TableHead>Producto</TableHead>
            <TableHead>Pedido</TableHead>
            <TableHead className="text-right">Cantidad</TableHead>
            <TableHead>Decisión</TableHead>
            <TableHead>Motivo</TableHead>
            <TableHead className="text-right">Stock restante</TableHead>
            <TableHead>Estado</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filas.map((m) => (
            <TableRow key={m.id}>
              <TableCell>{new Date(m.creadoEn).toLocaleDateString("es-MX")}</TableCell>
              <TableCell className="font-medium">{m.productoInfo?.producto ?? "—"}</TableCell>
              <TableCell>
                {m.pedidoInfo
                  ? `${m.pedidoInfo.folio ?? "—"} — ${m.pedidoInfo.cliente ?? "Cliente físico"}`
                  : "—"}
              </TableCell>
              <TableCell className="text-right">{m.cantidad}</TableCell>
              <TableCell>{m.decisionInfo?.nombre ?? "—"}</TableCell>
              <TableCell className="max-w-48 truncate" title={m.motivo}>
                {m.motivo}
              </TableCell>
              <TableCell className="text-right">{m.productoInfo?.stockRestante ?? "—"}</TableCell>
              <TableCell>
                <StatusBadge tone={m.estado ? "ok" : "neutral"}>
                  {m.estado ? "Activa" : "Inactiva"}
                </StatusBadge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
