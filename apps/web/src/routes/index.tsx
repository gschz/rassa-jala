import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rassa-jala/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rassa-jala/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { BarChart3, LayoutDashboard, Package, Users } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageContainer, PageHeader } from "@/components/page-header";
import { SkeletonMetrics } from "@/components/skeleton";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/http";
import { trpc } from "@/utils/trpc";

/**
 * P1-E Dashboard real (docs/roadmap.md §6 P1-E; docs/design-system.md §8): the
 * home view per role, EXCLUSIVELY with real server-side data — the legacy
 * dashboards were 100% mocked and their numbers are NOT reproduced. The dev
 * slice pages that used to live here moved out and were later REMOVED as
 * production debt (P0-E; dev tooling untouched: rxdb-check and slice-e2e
 * exercise tRPC/RxDB modules directly, never routes).
 *
 * Charts are plain CSS bars (no chart libraries for the MVP); money is a string
 * from the server (display only — the client never computes money).
 */

export const Route = createFileRoute("/")({
  // Protected route (P0 auth): same silent-refresh gate as every module page.
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: DashboardRoute,
});

/** Legacy state labels for display — the values come straight from the catalogs. */
const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: "Pendiente",
  confirmado: "Confirmado",
  entregado: "Entregado",
  cancelado: "Cancelado",
  activo: "Activo",
  borrador: "Borrador",
  publicado: "Publicado",
  cerrado: "Cerrado",
};

// Display-only money formatting (es-MX thousands + 2 decimals); the server money
// string stays the source of truth — Number() here is presentation only.
const FORMATO_MONEDA = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 2 });

function dinero(valor: string | null | undefined): string {
  return `$${valor == null ? "—" : FORMATO_MONEDA.format(Number(valor))}`;
}

function DashboardRoute() {
  const session = useSession();
  switch (session.user?.rol) {
    case "Admin":
      return <DashboardAdmin />;
    case "Vendedor":
      return <DashboardVendedor />;
    case "Agricultor":
      return <DashboardAgricultor />;
    case "Cliente":
      return <DashboardCliente />;
    default:
      return (
        <PageContainer>
          <EmptyState
            icon={<LayoutDashboard />}
            title="Sin dashboard"
            description="No hay una vista de inicio definida para tu rol."
          />
        </PageContainer>
      );
  }
}

function TarjetaMetrica({
  titulo,
  valor,
  detalle,
}: Readonly<{ titulo: string; valor: string; detalle?: string }>) {
  return (
    <Card className="gap-2">
      <CardContent className="space-y-1 px-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {titulo}
        </p>
        <p className="text-2xl font-bold tracking-tight text-foreground">{valor}</p>
        {detalle != null && <p className="text-xs text-muted-foreground">{detalle}</p>}
      </CardContent>
    </Card>
  );
}

function GridMetricas({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">{children}</div>;
}

function MensajeCarga({ cargando, error }: Readonly<{ cargando: boolean; error: unknown }>) {
  if (cargando) return <SkeletonMetrics />;
  if (error) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">
          {error instanceof Error ? error.message : "No se pudieron cargar las métricas."}
        </CardContent>
      </Card>
    );
  }
  return null;
}

/** 'YYYY-MM-DD' → "lun 17" (the date is a Mazatlan business day label, UTC-anchored). */
function etiquetaDia(fecha: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    weekday: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${fecha}T00:00:00.000Z`));
}

/** Simple CSS bars — height scaled to the max value; no chart library. */
function BarrasPorDia({ datos }: Readonly<{ datos: Array<{ fecha: string; total: string }> }>) {
  const valores = datos.map((d) => Number(d.total));
  const max = Math.max(...valores, 0);
  if (max === 0) {
    return (
      <EmptyState
        icon={<BarChart3 />}
        title="Sin ventas en los últimos 7 días"
        description="Las barras aparecen cuando existan pedidos con ventas."
      />
    );
  }
  return (
    <div className="flex items-end gap-2 pt-2">
      {datos.map((d) => {
        const valor = Number(d.total);
        // Minimum visible sliver so a non-zero day never renders as 0 height.
        const altura = valor === 0 ? 0 : Math.max((valor / max) * 100, 4);
        return (
          <div key={d.fecha} className="flex flex-1 flex-col items-center gap-2">
            <div className="flex h-36 w-full items-end justify-center">
              <div
                className="w-full max-w-10 rounded-t-md bg-primary/80"
                style={{ height: `${altura}%` }}
                title={`${d.fecha}: $${d.total}`}
                role="img"
                aria-label={`${d.fecha}: ${d.total} pesos`}
              />
            </div>
            <span className="text-[11px] font-semibold uppercase text-muted-foreground">
              {etiquetaDia(d.fecha)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Horizontal distribution bars (real counts only; zero rows keep their bar empty). */
function Distribucion({
  datos,
}: Readonly<{ datos: Array<{ etiqueta: string; cantidad: number }> }>) {
  const max = Math.max(...datos.map((d) => d.cantidad), 0);
  return (
    <ul className="space-y-2">
      {datos.map((d) => (
        <li key={d.etiqueta} className="flex items-center gap-3 text-sm">
          <span className="w-40 shrink-0 truncate text-muted-foreground">{d.etiqueta}</span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/80"
              style={{ width: max === 0 ? "0%" : `${(d.cantidad / max) * 100}%` }}
            />
          </div>
          <span className="w-8 text-right font-medium tabular-nums">{d.cantidad}</span>
        </li>
      ))}
    </ul>
  );
}

// ---- Admin ----

function DashboardAdmin() {
  const stats = useQuery(trpc.dashboard.admin.queryOptions());
  // T27: average delivery time (historiales.tiempoEntrega, Admin-only) — a
  // separate query so a slow aggregate never delays the main metrics panel.
  const tiempo = useQuery(trpc.historiales.tiempoEntrega.queryOptions({}));
  const carga = <MensajeCarga cargando={stats.isLoading} error={stats.error} />;

  return (
    <PageContainer>
      <PageHeader
        title="Inicio"
        description="Panel del negocio con datos reales del servidor: ventas, pedidos y usuarios."
      />
      {stats.isLoading || stats.error ? (
        carga
      ) : (
        <>
          <GridMetricas>
            <TarjetaMetrica titulo="Ventas de hoy" valor={dinero(stats.data?.ventasHoy)} />
            <TarjetaMetrica titulo="Ventas del mes" valor={dinero(stats.data?.ventasMes)} />
            <TarjetaMetrica
              titulo="Pedidos activos"
              valor={String(stats.data?.pedidosActivos ?? "—")}
            />
            <TarjetaMetrica
              titulo="Productos activos"
              valor={String(stats.data?.productosActivos ?? "—")}
            />
            <TarjetaMetrica
              titulo="Productores activos"
              valor={String(stats.data?.agricultoresActivos ?? "—")}
            />
            <TarjetaMetrica
              titulo="Tiempo promedio de entrega"
              valor={
                tiempo.data?.promedioHoras == null
                  ? "—"
                  : `${tiempo.data.promedioHoras.toFixed(1)} h`
              }
              detalle={`${tiempo.data?.pedidosEntregados ?? 0} pedidos entregados · últimos ${tiempo.data?.dias ?? 30} días`}
            />
          </GridMetricas>

          <Card>
            <CardHeader>
              <CardTitle>Ventas por día (últimos 7 días)</CardTitle>
              <CardDescription>Total de pedidos no cancelados por día de negocio.</CardDescription>
            </CardHeader>
            <CardContent>
              <BarrasPorDia datos={stats.data?.ventasPorDia ?? []} />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Pedidos por estado</CardTitle>
                <CardDescription>Distribución del catálogo de estados.</CardDescription>
              </CardHeader>
              <CardContent>
                <Distribucion
                  datos={(stats.data?.pedidosPorEstado ?? []).map((e) => ({
                    etiqueta: ETIQUETA_ESTADO[e.estado] ?? e.estado,
                    cantidad: e.cantidad,
                  }))}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Usuarios por rol</CardTitle>
                <CardDescription>Cuentas activas por rol.</CardDescription>
              </CardHeader>
              <CardContent>
                <Distribucion
                  datos={(stats.data?.usuariosPorRol ?? []).map((r) => ({
                    etiqueta: r.rol,
                    cantidad: r.cantidad,
                  }))}
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Productos más vendidos</CardTitle>
              <CardDescription>
                Por importe vendido (líneas de pedidos no cancelados).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {(stats.data?.topProductos ?? []).length === 0 ? (
                <EmptyState
                  icon={<Package />}
                  title="Sin líneas vendidas"
                  description="Aparecerán cuando existan pedidos con productos."
                />
              ) : (
                <ul className="divide-y">
                  {(stats.data?.topProductos ?? []).map((p) => (
                    <li key={p.nombre} className="flex items-center justify-between py-2 text-sm">
                      <span>{p.nombre}</span>
                      <span className="font-medium">
                        {dinero(p.importe)} · {p.pedidos} líneas
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Actividad reciente</CardTitle>
              <CardDescription>Los últimos cinco pedidos registrados.</CardDescription>
            </CardHeader>
            <CardContent>
              {(stats.data?.actividadReciente ?? []).length === 0 ? (
                <EmptyState
                  icon={<Users />}
                  title="Sin pedidos aún"
                  description="Los pedidos recientes del negocio aparecerán aquí."
                />
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Pedido</TableHead>
                        <TableHead>Cliente</TableHead>
                        <TableHead>Vendedor</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead>Estado</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(stats.data?.actividadReciente ?? []).map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">{p.folio}</TableCell>
                          <TableCell>{p.cliente ?? "Cliente físico"}</TableCell>
                          <TableCell>{p.vendedor ?? "Sin reclamar"}</TableCell>
                          <TableCell className="text-right">{dinero(p.total)}</TableCell>
                          <TableCell>{ETIQUETA_ESTADO[p.estado] ?? p.estado}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}

// ---- Vendedor ----

function DashboardVendedor() {
  const stats = useQuery(trpc.dashboard.vendedor.queryOptions());
  const carga = <MensajeCarga cargando={stats.isLoading} error={stats.error} />;

  return (
    <PageContainer>
      <PageHeader
        title="Inicio"
        description="Tus métricas de venta: pedidos propios, cobros pendientes y entregas."
      />
      {stats.isLoading || stats.error ? (
        carga
      ) : (
        <GridMetricas>
          <TarjetaMetrica titulo="Ventas de hoy" valor={dinero(stats.data?.ventasHoy)} />
          <TarjetaMetrica titulo="Ventas de la semana" valor={dinero(stats.data?.ventasSemana)} />
          <TarjetaMetrica titulo="Ventas del mes" valor={dinero(stats.data?.ventasMes)} />
          <TarjetaMetrica
            titulo="Pedidos por cobrar"
            valor={String(stats.data?.pedidosPorCobrar ?? "—")}
            detalle="Pedidos pendientes sin cobrar"
          />
          <TarjetaMetrica
            titulo="Pedidos por entregar"
            valor={String(stats.data?.pedidosPorEntregar ?? "—")}
            detalle="Confirmados en camino a entrega"
          />
        </GridMetricas>
      )}
    </PageContainer>
  );
}

// ---- Agricultor ----

function DashboardAgricultor() {
  const stats = useQuery(trpc.dashboard.agricultor.queryOptions());
  const carga = <MensajeCarga cargando={stats.isLoading} error={stats.error} />;

  return (
    <PageContainer>
      <PageHeader
        title="Inicio"
        description="Tus publicaciones semanales, ventas y recolecciones."
      />
      {stats.isLoading || stats.error ? (
        carga
      ) : (
        <>
          <GridMetricas>
            <TarjetaMetrica
              titulo="Ofertas activas"
              valor={String(stats.data?.itemsActivos ?? "—")}
            />
            <TarjetaMetrica
              titulo="Líneas vendidas"
              valor={String(stats.data?.lineasVendidas ?? "—")}
            />
            <TarjetaMetrica titulo="Ventas totales" valor={dinero(stats.data?.ventasTotales)} />
            <TarjetaMetrica
              titulo="Recolecciones pendientes"
              valor={String(stats.data?.recoleccionesPendientes ?? "—")}
            />
            <TarjetaMetrica
              titulo="Mermas registradas"
              valor={String(stats.data?.mermasRegistradas ?? "—")}
            />
          </GridMetricas>
          <Card>
            <CardHeader>
              <CardTitle>Publicaciones por estado</CardTitle>
              <CardDescription>Tus publicaciones semanales por estado.</CardDescription>
            </CardHeader>
            <CardContent>
              <Distribucion
                datos={(stats.data?.publicacionesPorEstado ?? []).map((p) => ({
                  etiqueta: ETIQUETA_ESTADO[p.estado] ?? p.estado,
                  cantidad: p.cantidad,
                }))}
              />
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}

// ---- Cliente ----

function DashboardCliente() {
  const stats = useQuery(trpc.dashboard.cliente.queryOptions());
  const carga = <MensajeCarga cargando={stats.isLoading} error={stats.error} />;

  return (
    <PageContainer>
      <PageHeader title="Inicio" description="Resumen de tus pedidos." />
      {stats.isLoading || stats.error ? (
        carga
      ) : (
        <GridMetricas>
          <TarjetaMetrica
            titulo="Pedidos totales"
            valor={String(stats.data?.pedidosTotales ?? "—")}
          />
          <TarjetaMetrica titulo="Por pagar" valor={String(stats.data?.porPagar ?? "—")} />
          <TarjetaMetrica titulo="Por recibir" valor={String(stats.data?.porRecibir ?? "—")} />
          <TarjetaMetrica titulo="Entregados" valor={String(stats.data?.entregados ?? "—")} />
          <TarjetaMetrica titulo="Gasto total" valor={dinero(stats.data?.gastoTotal)} />
        </GridMetricas>
      )}
    </PageContainer>
  );
}
