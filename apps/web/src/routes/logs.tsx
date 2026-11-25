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
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { PageContainer } from "@/components/page-header";
import { SkeletonTable } from "@/components/skeleton";
import { trpc } from "@/utils/trpc";

/**
 * T11 gap-pass-7 — Bitácora de auditoría (M-7, backend-audit §2.6): Admin-only,
 * read-only listing of the append-only `logs` table (who did what, from where, when).
 * Server-paginated (logs.list); the acción vocabulary comes from logs.acciones.
 */

export const Route = createFileRoute("/logs")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: LogsRoute,
});

type FilaLog = {
  id: string;
  accion: string;
  entidad: string | null;
  entidadId: string | null;
  ip: string;
  dispositivo: string;
  detalle?: unknown;
  creadoEn: string;
  usuario: { id: string; correo: string; nombre: string | null } | null;
};

type UsuarioLista = { id: string; correo: string; nombre: string; apellidoPaterno: string };

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function detalleResumen(detalle: unknown): string {
  if (detalle === null || detalle === undefined) return "—";
  const texto = JSON.stringify(detalle);
  return texto.length > 80 ? `${texto.slice(0, 77)}…` : texto;
}

function LogsRoute() {
  const session = useSession();
  if (session.user?.rol !== "Admin") {
    return (
      <PageContainer>
        <Card>
          <CardHeader>
            <CardTitle>Solo Admin</CardTitle>
            <CardDescription>
              Solo el rol Admin puede consultar la bitácora de auditoría.
            </CardDescription>
          </CardHeader>
        </Card>
      </PageContainer>
    );
  }
  return <BitacoraAdmin />;
}

function BitacoraAdmin() {
  const [usuarioFiltro, setUsuarioFiltro] = useState("");
  const [accionFiltro, setAccionFiltro] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [pagina, setPagina] = useState(1);

  const acciones = useQuery(trpc.logs.acciones.queryOptions());
  const usuarios = useQuery(trpc.usuarios.list.queryOptions({ page: 1, pageSize: 200 }));

  const consulta = useQuery(
    trpc.logs.list.queryOptions({
      page: pagina,
      pageSize: 50,
      ...(usuarioFiltro ? { usuarioId: usuarioFiltro } : {}),
      ...(accionFiltro ? { accion: accionFiltro } : {}),
      ...(desde ? { desde } : {}),
      ...(hasta ? { hasta } : {}),
    }),
  );

  const aplicar = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setPagina(1);
    void consulta.refetch();
  };

  const filas = consulta.data?.filas ?? [];
  const total = consulta.data?.total ?? 0;
  const pageSize = consulta.data?.pageSize ?? 50;
  const hayPaginaAnterior = pagina > 1;
  const hayPaginaSiguiente = pagina * pageSize < total;

  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Bitácora</h1>
        <p className="text-sm text-muted-foreground">
          Registro de auditoría: quién hizo qué, desde dónde y cuándo. Solo lectura; los registros
          no se pueden editar ni eliminar.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
          <CardDescription>
            {consulta.data ? `${total} registros coinciden con el filtro.` : "Cargando…"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={aplicar} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="logs-usuario">Usuario</Label>
              <select
                id="logs-usuario"
                value={usuarioFiltro}
                onChange={(event) => setUsuarioFiltro(event.target.value)}
                className="flex h-10 w-56 rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                <option value="">Todos</option>
                {(usuarios.data?.usuarios ?? []).map((u: UsuarioLista) => (
                  <option key={u.id} value={u.id}>
                    {u.correo}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="logs-accion">Acción</Label>
              <select
                id="logs-accion"
                value={accionFiltro}
                onChange={(event) => setAccionFiltro(event.target.value)}
                className="flex h-10 w-52 rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                <option value="">Todas</option>
                {(acciones.data ?? []).map((accion) => (
                  <option key={accion} value={accion}>
                    {accion}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="logs-desde">Desde</Label>
              <Input
                id="logs-desde"
                type="date"
                value={desde}
                onChange={(event) => setDesde(event.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="logs-hasta">Hasta</Label>
              <Input
                id="logs-hasta"
                type="date"
                value={hasta}
                onChange={(event) => setHasta(event.target.value)}
                className="w-40"
              />
            </div>
            <Button type="submit" variant="outline" size="sm">
              Filtrar
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registros</CardTitle>
          <CardDescription>Página {pagina} · 50 por página.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {consulta.isPending ? <SkeletonTable rows={5} /> : <TablaLogs filas={filas} />}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hayPaginaAnterior || consulta.isPending}
              onClick={() => setPagina((p) => Math.max(1, p - 1))}
            >
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hayPaginaSiguiente || consulta.isPending}
              onClick={() => setPagina((p) => p + 1)}
            >
              Siguiente
            </Button>
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}

function TablaLogs(props: Readonly<{ filas: FilaLog[] }>) {
  if (props.filas.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin registros.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-3 font-medium">Fecha</th>
            <th className="py-1 pr-3 font-medium">Usuario</th>
            <th className="py-1 pr-3 font-medium">Acción</th>
            <th className="py-1 pr-3 font-medium">Entidad</th>
            <th className="py-1 pr-3 font-medium">IP</th>
            <th className="py-1 pr-3 font-medium">Dispositivo</th>
            <th className="py-1 font-medium">Detalle</th>
          </tr>
        </thead>
        <tbody>
          {props.filas.map((f) => (
            <tr key={f.id} className="border-t">
              <td className="py-1.5 pr-3 whitespace-nowrap">{fechaCorta(f.creadoEn)}</td>
              <td className="py-1.5 pr-3">{f.usuario?.correo ?? "—"}</td>
              <td className="py-1.5 pr-3 font-mono text-xs">{f.accion}</td>
              <td className="py-1.5 pr-3 font-mono text-xs">
                {f.entidad ?? "—"}
                {f.entidadId ? ` · ${f.entidadId.slice(0, 8)}` : ""}
              </td>
              <td className="py-1.5 pr-3 font-mono text-xs">{f.ip}</td>
              <td className="py-1.5 pr-3 text-muted-foreground">{f.dispositivo}</td>
              <td className="max-w-64 truncate py-1.5 pr-3 font-mono text-xs text-muted-foreground">
                {detalleResumen(f.detalle)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
