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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rassa-jala/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Vault } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { PageContainer, PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/http";
import { useOnline } from "@/hooks/use-online";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/**
 * P1-A Cortes de caja (docs/roadmap.md §6 P1-A; docs/database.md §6.2 M-15). First
 * module UI born WITH the design system (docs/design-system.md phases 5-13 start
 * here): PageContainer/PageHeader + StatusBadge + EmptyState + LoadingState +
 * ConfirmDialog + Table, semantic tokens only, no emojis, shadcn spacing scale.
 *
 * ONLINE-CONFIRM lane (COL23 — no RxDB collection, M-15): everything is
 * server-fetched via TanStack Query and gated on connectivity, mirroring
 * recolecciones. Roles (legacy IsAdminOrVendedor parity): Vendedor sees/creates its
 * OWN daily corte; Admin sees all and creates its own day; Agricultor/Cliente 403.
 *
 * The teorico/diferencia snapshot is computed and frozen server-side at creation
 * (C3) — the form only collects the counted drawer cash (monto real) and the date;
 * the teorico preview is an estimate that may drift until the corte is generated.
 */

export const Route = createFileRoute("/cortes")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: CortesRoute,
});

const TONO_ESTADO: Record<string, StatusTone> = {
  abierto: "pending",
  cerrado: "info",
  cuadrado: "ok",
};

const ETIQUETA_ESTADO: Record<string, string> = {
  abierto: "Abierto",
  cerrado: "Cerrado",
  cuadrado: "Cuadrado",
};

type CorteDto = {
  id: string;
  fkVendedor: string | null;
  vendedorNombre: string | null;
  fecha: string;
  montoTeorico: string;
  montoReal: string;
  diferencia: string;
  estado: string;
  version: number;
  actualizadoEn: string;
};

/** Business today (America/Mazatlan) for the date default — same rule as the API. */
function hoyNegocio(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mazatlan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function CortesRoute() {
  const session = useSession();
  if (session.user?.rol !== "Vendedor" && session.user?.rol !== "Admin") {
    return (
      <PageContainer>
        <EmptyState
          icon={<Vault />}
          title="Sin acceso"
          description="Solo Vendedor y Admin consultan cortes de caja."
        />
      </PageContainer>
    );
  }
  return <CortesPage />;
}

function CortesPage() {
  const isOnline = useOnline();
  const listado = useQuery(trpc.cortes.listar.queryOptions(undefined));
  const recargar = (): void => void listado.refetch();

  return (
    <PageContainer>
      <PageHeader
        title="Cortes de caja"
        description="Cierre diario de caja por vendedor: el monto teórico y la diferencia se calculan y congelan en el servidor al generar el corte."
      />

      <FormaCrear isOnline={isOnline} recargar={recargar} />

      <ListaCortes
        filas={listado.data ?? []}
        cargando={listado.isLoading}
        error={listado.error?.message ?? null}
        isOnline={isOnline}
        recargar={recargar}
      />
    </PageContainer>
  );
}

function FormaCrear({ isOnline, recargar }: Readonly<{ isOnline: boolean; recargar: () => void }>) {
  const [fecha, setFecha] = useState(hoyNegocio());
  const [montoReal, setMontoReal] = useState("");
  const [confirmar, setConfirmar] = useState(false);
  const queryClient = useQueryClient();

  const teorico = useQuery(
    trpc.cortes.teorico.queryOptions({ fecha }, { enabled: isOnline && fecha.length > 0 }),
  );

  const crear = useMutation(
    trpc.cortes.crear.mutationOptions({
      onSuccess: () => {
        toast.success("Corte generado y congelado");
        setMontoReal("");
        void queryClient.invalidateQueries({ queryKey: trpc.cortes.teorico.queryKey() });
        recargar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  const montoValido = /^\d{1,10}(\.\d{1,2})?$/.test(montoReal);
  const puedoEnviar = isOnline && fecha.length > 0 && montoValido && !crear.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generar corte</CardTitle>
        <CardDescription>
          {isOnline
            ? "El monto teórico (efectivo cobrado el día) lo calcula el servidor; el corte es único por fecha y no se puede editar."
            : "Sin conexión: generar un corte requiere confirmación del servidor."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="corte-fecha">Fecha</Label>
            <Input
              id="corte-fecha"
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="corte-monto">Monto real contado (efectivo en caja)</Label>
            <Input
              id="corte-monto"
              inputMode="decimal"
              placeholder="0.00"
              value={montoReal}
              onChange={(e) => setMontoReal(e.target.value)}
            />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Monto teórico estimado del día:{" "}
          <span className="font-medium text-foreground">
            {isOnline ? (teorico.data?.montoTeorico ?? "—") : "—"}
          </span>
        </p>
        <Button disabled={!puedoEnviar} onClick={() => setConfirmar(true)}>
          {crear.isPending ? "Generando…" : "Generar corte"}
        </Button>
        <ConfirmDialog
          open={confirmar}
          onOpenChange={setConfirmar}
          title="¿Generar el corte de caja?"
          description="El corte congela el monto teórico y la diferencia al momento de crearse; no se puede editar ni repetir para la misma fecha."
          confirmLabel="Generar corte"
          onConfirm={() =>
            crear.mutate({
              montoReal,
              fecha,
              operationId: crypto.randomUUID(),
            })
          }
        />
      </CardContent>
    </Card>
  );
}

/** Diferencia with an explicit sign (money is a string from the server — display only). */
function Diferencia({ valor }: Readonly<{ valor: string }>) {
  const negativo = valor.startsWith("-");
  const abs = negativo ? valor.slice(1) : valor;
  const signo = negativo ? "−" : valor === "0.00" ? "" : "+";
  return (
    <span className={negativo ? "text-destructive" : undefined}>
      {signo}
      {abs}
    </span>
  );
}

function ListaCortes({
  filas,
  cargando,
  error,
  isOnline,
  recargar,
}: Readonly<{
  filas: CorteDto[];
  cargando: boolean;
  error: string | null;
  isOnline: boolean;
  recargar: () => void;
}>) {
  if (cargando) {
    return <LoadingState message="Cargando cortes de caja" />;
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
        icon={<Vault />}
        title="Sin cortes de caja"
        description={
          isOnline
            ? "Genera el primer corte con el monto contado del día."
            : "Los cortes se consultan en línea; revisa tu conexión."
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
            <TableHead>Vendedor</TableHead>
            <TableHead className="text-right">Teórico</TableHead>
            <TableHead className="text-right">Real</TableHead>
            <TableHead className="text-right">Diferencia</TableHead>
            <TableHead>Estado</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filas.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">{c.fecha}</TableCell>
              <TableCell>{c.vendedorNombre ?? "—"}</TableCell>
              <TableCell className="text-right">{c.montoTeorico}</TableCell>
              <TableCell className="text-right">{c.montoReal}</TableCell>
              <TableCell className="text-right">
                <Diferencia valor={c.diferencia} />
              </TableCell>
              <TableCell>
                <StatusBadge tone={TONO_ESTADO[c.estado] ?? "neutral"}>
                  {ETIQUETA_ESTADO[c.estado] ?? c.estado}
                </StatusBadge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
