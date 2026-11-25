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
import { useState } from "react";
import { toast } from "sonner";

import { getAccessToken, useSession } from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/http";
import { useOnline } from "@/hooks/use-online";
import { transicionRecoleccion } from "@rassa-jala/db/estados-recoleccion";
import { hoyNegocio } from "@rassa-jala/db/iso-semana";
import { HistorialTimeline } from "@/components/historial-timeline";
import { PageContainer } from "@/components/page-header";
import { BotonContactar } from "@/components/boton-contactar";
import { SkeletonCards } from "@/components/skeleton";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/**
 * P0 Recolecciones — the seller's harvest-collection agenda (docs/roadmap.md §5
 * P0-B; docs/database.md §6.2 + synchronization.md §9: ONLINE-CONFIRM lane —
 * the R1 slot uniqueness is adjudicated by the server, so there is NO local
 * collection (COL23: the web already opens 13 RxDB collections). Everything is
 * server-fetched via TanStack Query and gated on connectivity: the agenda and
 * every action require being online, mirroring the pagos modals pattern.
 *
 * Roles (legacy HasRole parity): Admin/Vendedor operate the shared agenda;
 * Agricultor reads only its own; Cliente has no access.
 */

export const Route = createFileRoute("/recolecciones")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: RecoleccionesRoute,
});

const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: "Pendiente",
  en_ruta: "En ruta",
  recolectado: "Recolectado",
  cancelado: "Cancelado",
};

type RecoleccionDto = {
  id: string;
  fkAgricultor: string;
  agricultorNombre: string | null;
  localidad: string | null;
  municipio: string | null;
  fechaRecoleccion: string;
  horaInicio: string | null;
  horaFin: string | null;
  estado: string;
  comentarios: string | null;
  version: number;
  actualizadoEn: string;
};

/**
 * T22 (PDF M5.7): the agenda groups by the farmer's location (localidad, with
 * its municipio in parentheses) so an operator plans route stops; groups sort
 * alphabetically and "Sin ubicación" goes last. Rows keep the API's
 * fecha/hora order inside each group. T17 (gap-pass-7): the per-row "Contactar"
 * button NOW EXISTS (operator rows only — Admin/Vendedor open the 1:1 chat with
 * the farmer via chat.iniciarPrivado; a farmer viewing their own agenda would
 * only contact themselves).
 */
type GrupoUbicacion = { etiqueta: string; filas: RecoleccionDto[] };

function agruparPorUbicacion(filas: RecoleccionDto[]): GrupoUbicacion[] {
  const sinUbicacion: RecoleccionDto[] = [];
  const porLlave = new Map<string, RecoleccionDto[]>();
  for (const r of filas) {
    if (!r.localidad) {
      sinUbicacion.push(r);
      continue;
    }
    const llave = `${r.localidad}|${r.municipio ?? ""}`;
    const grupo = porLlave.get(llave);
    if (grupo) grupo.push(r);
    else porLlave.set(llave, [r]);
  }
  const grupos: GrupoUbicacion[] = [...porLlave.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([llave, fs]) => {
      const [localidad, municipio] = llave.split("|");
      return {
        etiqueta: municipio ? `${localidad} (${municipio})` : localidad!,
        filas: fs,
      };
    });
  if (sinUbicacion.length > 0) grupos.push({ etiqueta: "Sin ubicación", filas: sinUbicacion });
  return grupos;
}

function RecoleccionesRoute() {
  const session = useSession();
  if (
    session.user?.rol !== "Vendedor" &&
    session.user?.rol !== "Admin" &&
    session.user?.rol !== "Agricultor"
  ) {
    return (
      <PageContainer>
        <Card>
          <CardHeader>
            <CardTitle>Sin acceso</CardTitle>
            <CardDescription>
              Solo Vendedor, Admin y Agricultor consultan recolecciones.
            </CardDescription>
          </CardHeader>
        </Card>
      </PageContainer>
    );
  }
  return <RecoleccionesPage />;
}

function RecoleccionesPage() {
  const isOnline = useOnline();
  const esOperador = useSession().user?.rol !== "Agricultor";
  const agenda = useQuery(trpc.recolecciones.listar.queryOptions(undefined));
  const recargar = (): void => void agenda.refetch();

  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Recolecciones</h1>
        <p className="text-sm text-muted-foreground">
          {esOperador
            ? "Agenda de recolección de cosechas: un solo slot activo por agricultor y fecha."
            : "Tus recolecciones programadas."}
          {!isOnline && " — Requiere conexión (la agenda se consulta en línea)."}
        </p>
      </div>

      {esOperador && <FormaCrear isOnline={isOnline} recargar={recargar} />}

      <ListaAgenda
        filas={agenda.data ?? []}
        cargando={agenda.isLoading}
        error={agenda.error?.message ?? null}
        esOperador={esOperador}
        isOnline={isOnline}
        recargar={recargar}
      />
    </PageContainer>
  );
}

function FormaCrear({ isOnline, recargar }: Readonly<{ isOnline: boolean; recargar: () => void }>) {
  const agricultores = useQuery(trpc.recolecciones.agricultores.queryOptions());
  const [fkAgricultor, setFkAgricultor] = useState("");
  const [fecha, setFecha] = useState("");
  const [horaInicio, setHoraInicio] = useState("");
  const [horaFin, setHoraFin] = useState("");
  const [comentarios, setComentarios] = useState("");

  const crear = useMutation(
    trpc.recolecciones.crear.mutationOptions({
      onSuccess: () => {
        toast.success("Recolección agendada");
        setFecha("");
        setHoraInicio("");
        setHoraFin("");
        setComentarios("");
        recargar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  const puedoEnviar = isOnline && fkAgricultor.length > 0 && fecha.length > 0 && !crear.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nueva recolección</CardTitle>
        <CardDescription>
          {isOnline
            ? "La unicidad del slot (agricultor, fecha) la valida el servidor."
            : "Sin conexión: agendar requiere confirmación del servidor."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="reco-agricultor">Agricultor</Label>
            <select
              id="reco-agricultor"
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              value={fkAgricultor}
              onChange={(e) => setFkAgricultor(e.target.value)}
            >
              <option value="">Selecciona…</option>
              {(agricultores.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nombre} {a.apellidoPaterno}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="reco-fecha">Fecha</Label>
            <Input
              id="reco-fecha"
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reco-inicio">Hora inicio (opcional)</Label>
            <Input
              id="reco-inicio"
              type="time"
              value={horaInicio}
              onChange={(e) => setHoraInicio(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reco-fin">Hora fin (opcional)</Label>
            <Input
              id="reco-fin"
              type="time"
              value={horaFin}
              onChange={(e) => setHoraFin(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="reco-comentarios">Comentarios (opcional)</Label>
          <Input
            id="reco-comentarios"
            value={comentarios}
            onChange={(e) => setComentarios(e.target.value)}
            placeholder="Punto de encuentro, volumen estimado…"
          />
        </div>
        <Button
          disabled={!puedoEnviar}
          onClick={() =>
            crear.mutate({
              fkAgricultor,
              fechaRecoleccion: fecha,
              ...(horaInicio ? { horaInicio } : {}),
              ...(horaFin ? { horaFin } : {}),
              ...(comentarios.trim() ? { comentarios: comentarios.trim() } : {}),
            })
          }
        >
          {crear.isPending ? "Agendando…" : "Agendar recolección"}
        </Button>
      </CardContent>
    </Card>
  );
}

function ListaAgenda({
  filas,
  cargando,
  error,
  esOperador,
  isOnline,
  recargar,
}: Readonly<{
  filas: RecoleccionDto[];
  cargando: boolean;
  error: string | null;
  esOperador: boolean;
  isOnline: boolean;
  recargar: () => void;
}>) {
  const avanzar = useMutation(
    trpc.recolecciones.avanzar.mutationOptions({
      onSuccess: () => {
        toast.success("Estado actualizado");
        recargar();
      },
      onError: (error) => notificarError(error),
    }),
  );
  const cancelar = useMutation(
    trpc.recolecciones.cancelar.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.mensaje);
        recargar();
      },
      onError: (error) => notificarError(error),
    }),
  );
  const [historialId, setHistorialId] = useState<string | null>(null);
  const historial = useQuery({
    ...trpc.historiales.historialRecoleccion.queryOptions({ id: historialId ?? "" }),
    enabled: historialId !== null,
  });

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
          Sin recolecciones en la agenda.
        </CardContent>
      </Card>
    );
  }
  const pendienteAccion = avanzar.isPending || cancelar.isPending;
  // Gap 13: the action buttons mirror the server's EXACT transition predicate
  // (transicionRecoleccion — the same pure helper the API enforces), so a row the
  // server would reject with 400 never renders its button. In particular the
  // late-completion jump "Recolectado" only appears for `pendiente` rows whose
  // fecha < hoy (America/Mazatlan): today's and future rows hide it, because the
  // server applies strict bounds (fecha < hoy).
  const hoy = hoyNegocio(new Date());
  const grupos = agruparPorUbicacion(filas);
  return (
    <div className="space-y-6">
      {grupos.map((grupo) => (
        <section key={grupo.etiqueta} className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {grupo.etiqueta}
          </h2>
          <div className="space-y-2">
            {grupo.filas.map((r) => {
              const puedeIniciarRuta =
                esOperador &&
                transicionRecoleccion(r.estado, "en_ruta", r.fechaRecoleccion, hoy).ok;
              const puedeRecolectar =
                esOperador &&
                transicionRecoleccion(r.estado, "recolectado", r.fechaRecoleccion, hoy).ok;
              const puedeCancelar =
                esOperador &&
                transicionRecoleccion(r.estado, "cancelado", r.fechaRecoleccion, hoy).ok;
              return (
                <Card key={r.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">
                        {r.fechaRecoleccion}
                        {r.horaInicio ? ` · ${r.horaInicio.slice(0, 5)}` : ""}
                        {r.horaFin ? `–${r.horaFin.slice(0, 5)}` : ""} ·{" "}
                        {ETIQUETA_ESTADO[r.estado] ?? r.estado}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {r.agricultorNombre ?? r.fkAgricultor.slice(0, 8)}
                        {r.comentarios ? ` — ${r.comentarios}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {esOperador && <BotonContactar fkUsuario={r.fkAgricultor} />}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setHistorialId(historialId === r.id ? null : r.id)}
                      >
                        Historial
                      </Button>
                      {esOperador && (
                        <>
                          {puedeIniciarRuta && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!isOnline || pendienteAccion}
                              onClick={() =>
                                avanzar.mutate({ id: r.id, estado: "en_ruta", version: r.version })
                              }
                            >
                              Iniciar ruta
                            </Button>
                          )}
                          {puedeRecolectar && (
                            <Button
                              size="sm"
                              disabled={!isOnline || pendienteAccion}
                              onClick={() =>
                                avanzar.mutate({
                                  id: r.id,
                                  estado: "recolectado",
                                  version: r.version,
                                })
                              }
                            >
                              Recolectado
                            </Button>
                          )}
                          {puedeCancelar && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!isOnline || pendienteAccion}
                              onClick={() => cancelar.mutate({ id: r.id, version: r.version })}
                            >
                              Cancelar
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                    {historialId === r.id && (
                      <div className="w-full border-t pt-2">
                        <p className="mb-1 text-sm font-medium">Historial de estados</p>
                        <HistorialTimeline
                          cargando={historial.isLoading}
                          error={historial.error?.message ?? null}
                          filas={historial.data ?? []}
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
