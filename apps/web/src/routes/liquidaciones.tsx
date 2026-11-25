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
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Wallet } from "lucide-react";
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
 * P1-B Liquidaciones (docs/roadmap.md §6 P1-B; docs/database.md §6.2 M-16). Design
 * system compositions (PageHeader + StatusBadge + EmptyState + LoadingState +
 * ConfirmDialog + Table), semantic tokens only, Spanish copy.
 *
 * ONLINE-CONFIRM lane (COL23 — no RxDB collection, M-16): everything is
 * server-fetched via TanStack Query and gated on connectivity. Roles (legacy
 * HasRole(ADMIN) parity — the ENTIRE module is Admin-only): Vendedor/Agricultor/
 * Cliente see an access-denied state (the server 403s every procedure too).
 *
 * The amounts are computed and frozen server-side at calcular (monto_ventas from the
 * agricultor's own delivered lines, comision = HALF_UP 10%, monto_liquidar); the
 * marcar-pagada dialog only collects the payment type and reference — never an amount.
 */

export const Route = createFileRoute("/liquidaciones")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: LiquidacionesRoute,
});

const TONO_ESTADO: Record<string, StatusTone> = {
  pendiente: "pending",
  parcial: "info",
  pagada: "ok",
};

const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: "Pendiente",
  parcial: "Parcial",
  pagada: "Pagada",
};

type LiquidacionDto = {
  id: string;
  fkAgricultor: string | null;
  agricultorNombre: string | null;
  periodoInicio: string;
  periodoFin: string;
  montoVentas: string;
  tasaComision: string;
  comision: string;
  montoLiquidar: string;
  estado: string;
  folioPago: string | null;
  version: number;
};

type AgricultorDto = { id: string; nombre: string; apellidoPaterno: string; estado: boolean };
type TipoPagoDto = { id: string; nombre: string };

function LiquidacionesRoute() {
  const session = useSession();
  if (session.user?.rol !== "Admin") {
    return (
      <PageContainer>
        <EmptyState
          icon={<Wallet />}
          title="Sin acceso"
          description="Solo el rol Admin consulta liquidaciones."
        />
      </PageContainer>
    );
  }
  return <LiquidacionesPage />;
}

function LiquidacionesPage() {
  const isOnline = useOnline();
  const listado = useQuery(trpc.liquidaciones.listar.queryOptions(undefined));
  const recargar = (): void => void listado.refetch();

  return (
    <PageContainer>
      <PageHeader
        title="Liquidaciones"
        description="Cierre semanal por agricultor: el servidor calcula el monto de ventas (solo sus líneas entregadas), la comisión (10%) y el monto a liquidar; el pago de dispersión se registra con folio propio."
      />

      <FormaCalcular isOnline={isOnline} recargar={recargar} />

      <ListaLiquidaciones
        filas={listado.data ?? []}
        cargando={listado.isLoading}
        error={listado.error?.message ?? null}
        isOnline={isOnline}
        recargar={recargar}
      />
    </PageContainer>
  );
}

/** Monday of the current business week's ISO week numbers (same calendar as the API). */
function semanaEnCurso(): { semana: number; anio: number } {
  const hoy = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mazatlan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const fecha = new Date(`${hoy}T00:00:00Z`);
  const jueves = new Date(fecha);
  jueves.setUTCDate(
    jueves.getUTCDate() + ((7 - fecha.getUTCDay()) % 7 || 7) - fecha.getUTCDay() + 3,
  );
  const anioIso = jueves.getUTCFullYear();
  const ene4 = new Date(Date.UTC(anioIso, 0, 4));
  const lunesSemana1 = new Date(ene4);
  lunesSemana1.setUTCDate(lunesSemana1.getUTCDate() - ((ene4.getUTCDay() + 6) % 7));
  const semana = 1 + Math.round((fecha.getTime() - lunesSemana1.getTime()) / (7 * 86_400_000));
  return { semana, anio: anioIso };
}

function FormaCalcular({
  isOnline,
  recargar,
}: Readonly<{ isOnline: boolean; recargar: () => void }>) {
  const enCurso = semanaEnCurso();
  const [fkAgricultor, setFkAgricultor] = useState("");
  const [semana, setSemana] = useState(String(enCurso.semana));
  const [anio, setAnio] = useState(String(enCurso.anio));
  const [confirmar, setConfirmar] = useState(false);

  const agricultores = useQuery(
    trpc.usuarios.list.queryOptions(
      { rol: "Agricultor", estado: true, page: 1, pageSize: 200 },
      { enabled: isOnline },
    ),
  );
  const calcular = useMutation(
    trpc.liquidaciones.calcular.mutationOptions({
      onSuccess: () => {
        toast.success("Liquidación calculada");
        setFkAgricultor("");
        recargar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  const semanaValida = /^\d{1,3}$/.test(semana) && Number(semana) >= 1 && Number(semana) <= 53;
  const anioValido = /^\d{4}$/.test(anio) && Number(anio) >= 2000 && Number(anio) <= 2100;
  const puedoEnviar =
    isOnline && fkAgricultor !== "" && semanaValida && anioValido && !calcular.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Calcular liquidación</CardTitle>
        <CardDescription>
          {isOnline
            ? "El servidor suma SOLO las líneas entregadas del agricultor en la semana elegida y congela los montos; el periodo no se puede recalcular."
            : "Sin conexión: calcular una liquidación requiere confirmación del servidor."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="liq-agricultor">Agricultor</Label>
            <Select
              value={fkAgricultor}
              onValueChange={(valor) => setFkAgricultor(valor == null ? "" : String(valor))}
            >
              <SelectTrigger id="liq-agricultor" className="w-full">
                <SelectValue placeholder="Selecciona un agricultor" />
              </SelectTrigger>
              <SelectContent>
                {(agricultores.data?.usuarios ?? []).map((a: AgricultorDto) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.nombre} {a.apellidoPaterno}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="liq-semana">Semana (1–53)</Label>
            <Input
              id="liq-semana"
              inputMode="numeric"
              value={semana}
              onChange={(e) => setSemana(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="liq-anio">Año</Label>
            <Input
              id="liq-anio"
              inputMode="numeric"
              value={anio}
              onChange={(e) => setAnio(e.target.value)}
            />
          </div>
        </div>
        <Button disabled={!puedoEnviar} onClick={() => setConfirmar(true)}>
          {calcular.isPending ? "Calculando…" : "Calcular liquidación"}
        </Button>
        <ConfirmDialog
          open={confirmar}
          onOpenChange={setConfirmar}
          title="¿Calcular la liquidación?"
          description="El servidor congelará los montos de la semana; el periodo queda bloqueado (no se puede recalcular) hasta después del pago."
          confirmLabel="Calcular"
          onConfirm={() =>
            calcular.mutate({
              agricultor: fkAgricultor,
              semana: Number(semana),
              anio: Number(anio),
              operationId: crypto.randomUUID(),
            })
          }
        />
      </CardContent>
    </Card>
  );
}

function ListaLiquidaciones({
  filas,
  cargando,
  error,
  isOnline,
  recargar,
}: Readonly<{
  filas: LiquidacionDto[];
  cargando: boolean;
  error: string | null;
  isOnline: boolean;
  recargar: () => void;
}>) {
  if (cargando) {
    return <LoadingState message="Cargando liquidaciones" />;
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
        icon={<Wallet />}
        title="Sin liquidaciones"
        description={
          isOnline
            ? "Calcula la primera liquidación semanal de un agricultor."
            : "Las liquidaciones se consultan en línea; revisa tu conexión."
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
            <TableHead>Agricultor</TableHead>
            <TableHead>Periodo</TableHead>
            <TableHead className="text-right">Ventas</TableHead>
            <TableHead className="text-right">Comisión</TableHead>
            <TableHead className="text-right">A liquidar</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Folio pago</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {filas.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="font-medium">{l.agricultorNombre ?? "—"}</TableCell>
              <TableCell>
                {l.periodoInicio} → {l.periodoFin}
              </TableCell>
              <TableCell className="text-right">{l.montoVentas}</TableCell>
              <TableCell className="text-right">{l.comision}</TableCell>
              <TableCell className="text-right font-medium">{l.montoLiquidar}</TableCell>
              <TableCell>
                <StatusBadge tone={TONO_ESTADO[l.estado] ?? "neutral"}>
                  {ETIQUETA_ESTADO[l.estado] ?? l.estado}
                </StatusBadge>
              </TableCell>
              <TableCell>{l.folioPago ?? "—"}</TableCell>
              <TableCell>
                {l.estado === "pendiente" && (
                  <BotonPagar fila={l} isOnline={isOnline} recargar={recargar} />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BotonPagar({
  fila,
  isOnline,
  recargar,
}: Readonly<{ fila: LiquidacionDto; isOnline: boolean; recargar: () => void }>) {
  const [abierto, setAbierto] = useState(false);
  const [fkTipoPago, setFkTipoPago] = useState("");
  const [referencia, setReferencia] = useState("");
  const tipos = useQuery(trpc.pagos.tiposPago.queryOptions(undefined, { enabled: isOnline }));

  const pagar = useMutation(
    trpc.liquidaciones.marcarPagada.mutationOptions({
      onSuccess: () => {
        toast.success("Liquidación pagada");
        setReferencia("");
        recargar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  return (
    <>
      <Button size="sm" variant="outline" disabled={!isOnline} onClick={() => setAbierto(true)}>
        Marcar pagada
      </Button>
      <ConfirmDialog
        open={abierto}
        onOpenChange={setAbierto}
        title="¿Registrar el pago de dispersión?"
        description={`El servidor creará el pago de ${fila.montoLiquidar} con folio propio (sin afectar pedidos); el monto no se puede modificar ni repetir.`}
        confirmLabel="Marcar pagada"
        onConfirm={() =>
          pagar.mutate({
            id: fila.id,
            fkTipoPago,
            referencia: referencia || undefined,
            operationId: crypto.randomUUID(),
          })
        }
      >
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <Label htmlFor="liq-tipo-pago">Tipo de pago</Label>
            <Select
              value={fkTipoPago}
              onValueChange={(valor) => setFkTipoPago(valor == null ? "" : String(valor))}
            >
              <SelectTrigger id="liq-tipo-pago" className="w-full">
                <SelectValue placeholder="Selecciona el tipo" />
              </SelectTrigger>
              <SelectContent>
                {(tipos.data ?? []).map((t: TipoPagoDto) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="liq-referencia">Referencia (opcional)</Label>
            <Input
              id="liq-referencia"
              value={referencia}
              maxLength={100}
              onChange={(e) => setReferencia(e.target.value)}
            />
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}
