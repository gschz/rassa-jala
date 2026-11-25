import { Button } from "@rassa-jala/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rassa-jala/ui/components/card";
import { Input } from "@rassa-jala/ui/components/input";
import { Label } from "@rassa-jala/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { useRxQueryLive } from "@/lib/rxdb/use-live-query";
import type { MangoQuery } from "rxdb/plugins/core";
import { toast } from "sonner";

import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import {
  type CategoriaDoc,
  type LocalidadDoc,
  type MunicipioDoc,
  type RassaDatabase,
} from "@/lib/rxdb/database";
import { startReplications, type ReplicationSet } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { PageContainer } from "@/components/page-header";
import { FormError } from "@/components/form-error";
import { FormDialog } from "@/components/form-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/**
 * P0 Catálogos — online admin CRUD (docs/scope.md §3.1 "Catálogos — COMPLETAR").
 *
 * Architecture (synchronization.md §6/§9): catalog writes are online-confirm tRPC
 * mutations (the server writes the row + outbox in one transaction). The UI NEVER
 * writes RxDB for them and marks nothing confirmed before the server answers; the
 * change becomes visible through PULL replication — a reSync is triggered right after
 * a successful mutation so it arrives immediately instead of on the next interval.
 * RxDB live queries remain the read source for active rows; the trpc list procedures
 * (incluirInactivos) back ONLY the trash view, because RxDB queries never return
 * _deleted documents.
 */

export const Route = createFileRoute("/catalogos")({
  // Protected route (same contract as /): token or one silent refresh.
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: CatalogosRoute,
});

// Stable query objects: a new object identity every render would make the
// live-query hooks resubscribe on every render.
const MUNICIPIOS_QUERY: MangoQuery<MunicipioDoc> = { sort: [{ nombre: "asc" }] };
const LOCALIDADES_QUERY: MangoQuery<LocalidadDoc> = { sort: [{ nombre: "asc" }] };
const CATEGORIAS_QUERY: MangoQuery<CategoriaDoc> = { sort: [{ nombre: "asc" }] };

/** Normalized row shape shared by the RxDB docs and the admin list DTOs. */
type FilaCatalogo = {
  id: string;
  nombre: string;
  fkMunicipio?: string;
  tipo?: string | null;
  abreviatura?: string | null;
  estado: boolean;
  version: number;
};

type ValoresFormulario = {
  nombre: string;
  fkMunicipio?: string;
  tipo?: string;
  abreviatura?: string;
};

/** Which extra fields the section's form/table show beyond the name. */
type CamposCatalogo = "nombre" | "municipio" | "unidad";

function CatalogosRoute() {
  const session = useSession();
  if (session.user?.rol !== "Admin") {
    return (
      <PageContainer>
        <Card>
          <CardHeader>
            <CardTitle>Solo Admin</CardTitle>
            <CardDescription>Solo el rol Admin puede administrar los catálogos.</CardDescription>
          </CardHeader>
        </Card>
      </PageContainer>
    );
  }
  return <CatalogosAdmin />;
}

function CatalogosAdmin() {
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

  // Right after a mutation the server change is pulled immediately instead of
  // waiting for the 15s reSync interval.
  const resincronizar = (): void => {
    repRef.current?.reSyncAll();
  };

  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Municipios</h1>
        <p className="text-sm text-muted-foreground">
          Los cambios se confirman en línea contra el servidor y se sincronizan con todos los
          dispositivos.
        </p>
      </div>
      <SeccionMunicipios db={db} resincronizar={resincronizar} />
      <SeccionLocalidades db={db} resincronizar={resincronizar} />
      <SeccionCategorias db={db} resincronizar={resincronizar} />
      <SeccionUnidades db={db} resincronizar={resincronizar} />
    </PageContainer>
  );
}

/** Shared success feedback: toast now, refresh the trash lists, pull the new state. */
function notificarExito(
  mensaje: string,
  queryClient: ReturnType<typeof useQueryClient>,
  resincronizar: () => void,
): void {
  toast.success(mensaje);
  void queryClient.invalidateQueries();
  resincronizar();
}

type PropsSeccion = Readonly<{
  db: RassaDatabase;
  resincronizar: () => void;
}>;

function SeccionMunicipios({ db, resincronizar }: PropsSeccion) {
  const queryClient = useQueryClient();
  const activos = useRxQueryLive<MunicipioDoc>({
    collection: db.municipios,
    query: MUNICIPIOS_QUERY,
  });
  const papelera = useQuery(trpc.catalogos.municipiosList.queryOptions({ incluirInactivos: true }));

  const crear = useMutation(
    trpc.catalogos.municipiosCreate.mutationOptions({
      onSuccess: () => notificarExito("Municipio creado", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const actualizar = useMutation(
    trpc.catalogos.municipiosUpdate.mutationOptions({
      onSuccess: () => notificarExito("Municipio actualizado", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const cambiarEstado = useMutation(
    trpc.catalogos.municipiosSetEstado.mutationOptions({
      onSuccess: (_, variables) =>
        notificarExito(
          variables.estado ? "Municipio restaurado" : "Municipio desactivado",
          queryClient,
          resincronizar,
        ),
      onError: (error) => notificarError(error),
    }),
  );

  return (
    <SeccionCatalogo
      titulo="Municipios"
      tituloNuevo="Nuevo municipio"
      descripcion="Catálogo geográfico global."
      campos="nombre"
      activos={activos.results.map((doc) => doc.toJSON() as MunicipioDoc)}
      papelera={(papelera.data ?? [])
        .filter((fila) => !fila.estado)
        .map((fila) => ({
          id: fila.id,
          nombre: fila.nombre,
          estado: fila.estado,
          version: fila.version,
        }))}
      cargandoPapelera={papelera.isPending}
      guardando={crear.isPending || actualizar.isPending}
      cambiandoEstado={cambiarEstado.isPending}
      onGuardar={async (valores, objetivo) => {
        if (objetivo) {
          await actualizar.mutateAsync({
            id: objetivo.id,
            version: objetivo.version,
            nombre: valores.nombre,
          });
        } else {
          await crear.mutateAsync({ nombre: valores.nombre });
        }
      }}
      onSetEstado={(fila, estado) =>
        cambiarEstado.mutate({ id: fila.id, version: fila.version, estado })
      }
    />
  );
}

function SeccionLocalidades({ db, resincronizar }: PropsSeccion) {
  const queryClient = useQueryClient();
  const activos = useRxQueryLive<LocalidadDoc>({
    collection: db.localidades,
    query: LOCALIDADES_QUERY,
  });
  const municipios = useRxQueryLive<MunicipioDoc>({
    collection: db.municipios,
    query: MUNICIPIOS_QUERY,
  });
  const papelera = useQuery(
    trpc.catalogos.localidadesList.queryOptions({ incluirInactivos: true }),
  );

  const crear = useMutation(
    trpc.catalogos.localidadesCreate.mutationOptions({
      onSuccess: () => notificarExito("Localidad creada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const actualizar = useMutation(
    trpc.catalogos.localidadesUpdate.mutationOptions({
      onSuccess: () => notificarExito("Localidad actualizada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const cambiarEstado = useMutation(
    trpc.catalogos.localidadesSetEstado.mutationOptions({
      onSuccess: (_, variables) =>
        notificarExito(
          variables.estado ? "Localidad restaurada" : "Localidad desactivada",
          queryClient,
          resincronizar,
        ),
      onError: (error) => notificarError(error),
    }),
  );

  const docsMunicipios = municipios.results.map((doc) => doc.toJSON() as MunicipioDoc);

  return (
    <SeccionCatalogo
      titulo="Localidades"
      tituloNuevo="Nueva localidad"
      descripcion="Catálogo geográfico por municipio. El municipio debe existir y estar activo."
      campos="municipio"
      municipios={docsMunicipios}
      activos={activos.results.map((doc) => doc.toJSON() as LocalidadDoc)}
      papelera={(papelera.data ?? [])
        .filter((fila) => !fila.estado)
        .map((fila) => ({
          id: fila.id,
          nombre: fila.nombre,
          fkMunicipio: fila.fkMunicipio,
          estado: fila.estado,
          version: fila.version,
        }))}
      cargandoPapelera={papelera.isPending}
      guardando={crear.isPending || actualizar.isPending}
      cambiandoEstado={cambiarEstado.isPending}
      onGuardar={async (valores, objetivo) => {
        if (objetivo) {
          await actualizar.mutateAsync({
            id: objetivo.id,
            version: objetivo.version,
            nombre: valores.nombre,
            // Send fkMunicipio only when it actually changed: an unchanged parent
            // avoids rejecting edits of localidades whose municipio is inactive.
            ...(valores.fkMunicipio && valores.fkMunicipio !== objetivo.fkMunicipio
              ? { fkMunicipio: valores.fkMunicipio }
              : {}),
          });
        } else {
          if (!valores.fkMunicipio) return;
          await crear.mutateAsync({
            nombre: valores.nombre,
            fkMunicipio: valores.fkMunicipio,
          });
        }
      }}
      onSetEstado={(fila, estado) =>
        cambiarEstado.mutate({ id: fila.id, version: fila.version, estado })
      }
    />
  );
}

function SeccionCategorias({ db, resincronizar }: PropsSeccion) {
  const queryClient = useQueryClient();
  const activos = useRxQueryLive<CategoriaDoc>({
    collection: db.categorias,
    query: CATEGORIAS_QUERY,
  });
  const papelera = useQuery(trpc.catalogos.categoriasList.queryOptions({ incluirInactivos: true }));

  const crear = useMutation(
    trpc.catalogos.categoriasCreate.mutationOptions({
      onSuccess: () => notificarExito("Categoría creada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const actualizar = useMutation(
    trpc.catalogos.categoriasUpdate.mutationOptions({
      onSuccess: () => notificarExito("Categoría actualizada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const cambiarEstado = useMutation(
    trpc.catalogos.categoriasSetEstado.mutationOptions({
      onSuccess: (_, variables) =>
        notificarExito(
          variables.estado ? "Categoría restaurada" : "Categoría desactivada",
          queryClient,
          resincronizar,
        ),
      onError: (error) => notificarError(error),
    }),
  );

  return (
    <SeccionCatalogo
      titulo="Categorías de producto"
      tituloNuevo="Nueva categoría"
      descripcion="Categorías del catálogo maestro de productos."
      campos="nombre"
      activos={activos.results.map((doc) => doc.toJSON() as CategoriaDoc)}
      papelera={(papelera.data ?? [])
        .filter((fila) => !fila.estado)
        .map((fila) => ({
          id: fila.id,
          nombre: fila.nombre,
          estado: fila.estado,
          version: fila.version,
        }))}
      cargandoPapelera={papelera.isPending}
      guardando={crear.isPending || actualizar.isPending}
      cambiandoEstado={cambiarEstado.isPending}
      onGuardar={async (valores, objetivo) => {
        if (objetivo) {
          await actualizar.mutateAsync({
            id: objetivo.id,
            version: objetivo.version,
            nombre: valores.nombre,
          });
        } else {
          await crear.mutateAsync({ nombre: valores.nombre });
        }
      }}
      onSetEstado={(fila, estado) =>
        cambiarEstado.mutate({ id: fila.id, version: fila.version, estado })
      }
    />
  );
}

function SeccionUnidades({ resincronizar }: PropsSeccion) {
  const queryClient = useQueryClient();
  // Stage A COL23 (M-18): no `unidades` RxDB collection — the section is ONLINE-only
  // (server-fetched actives + trash from the same tRPC list). Accepted cost: the
  // offline CRUD of unidades is gone (user decision 2026-11-20).
  const listado = useQuery(trpc.catalogos.unidadesList.queryOptions({ incluirInactivos: true }));
  const activos = listado.data ?? [];

  const crear = useMutation(
    trpc.catalogos.unidadesCreate.mutationOptions({
      onSuccess: () => notificarExito("Unidad creada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const actualizar = useMutation(
    trpc.catalogos.unidadesUpdate.mutationOptions({
      onSuccess: () => notificarExito("Unidad actualizada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const cambiarEstado = useMutation(
    trpc.catalogos.unidadesSetEstado.mutationOptions({
      onSuccess: (_, variables) =>
        notificarExito(
          variables.estado ? "Unidad restaurada" : "Unidad desactivada",
          queryClient,
          resincronizar,
        ),
      onError: (error) => notificarError(error),
    }),
  );

  return (
    <SeccionCatalogo
      titulo="Unidades de medida"
      tituloNuevo="Nueva unidad"
      descripcion="Unidades de medida del catálogo de productos. Tipo y abreviatura son opcionales."
      campos="unidad"
      activos={activos
        .filter((fila) => fila.estado)
        .map((fila) => ({
          id: fila.id,
          nombre: fila.nombre ?? fila.tipo ?? fila.abreviatura ?? "(sin nombre)",
          tipo: fila.tipo,
          abreviatura: fila.abreviatura,
          estado: fila.estado,
          version: fila.version,
        }))}
      papelera={(listado.data ?? [])
        .filter((fila) => !fila.estado)
        .map((fila) => ({
          id: fila.id,
          // Legacy rows may carry a null nombre; the display falls back like the
          // legacy admin did (nombre → tipo → abreviatura).
          nombre: fila.nombre ?? fila.tipo ?? fila.abreviatura ?? "(sin nombre)",
          tipo: fila.tipo,
          abreviatura: fila.abreviatura,
          estado: fila.estado,
          version: fila.version,
        }))}
      cargandoPapelera={listado.isPending}
      guardando={crear.isPending || actualizar.isPending}
      cambiandoEstado={cambiarEstado.isPending}
      onGuardar={async (valores, objetivo) => {
        // Empty strings arrive as null on the server (nullable columns).
        if (objetivo) {
          await actualizar.mutateAsync({
            id: objetivo.id,
            version: objetivo.version,
            nombre: valores.nombre,
            tipo: valores.tipo ?? null,
            abreviatura: valores.abreviatura ?? null,
          });
        } else {
          await crear.mutateAsync({
            nombre: valores.nombre,
            tipo: valores.tipo ?? null,
            abreviatura: valores.abreviatura ?? null,
          });
        }
      }}
      onSetEstado={(fila, estado) =>
        cambiarEstado.mutate({ id: fila.id, version: fila.version, estado })
      }
    />
  );
}

interface ContenidoPapeleraProps {
  cargando: boolean;
  papelera: FilaCatalogo[];
  campos: CamposCatalogo;
  cambiandoEstado?: boolean;
  etiquetaPapelera: (fila: FilaCatalogo) => string;
  onRestaurar: (fila: FilaCatalogo) => void;
}

function ContenidoPapelera(props: Readonly<ContenidoPapeleraProps>) {
  if (props.cargando) {
    return <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;
  }
  if (props.papelera.length === 0) {
    return <p className="text-xs text-muted-foreground">La papelera está vacía.</p>;
  }
  return (
    <ul className="space-y-1">
      {props.papelera.map((fila) => (
        <li key={fila.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
          <span className="text-sm">
            {fila.nombre}
            {props.campos === "municipio" && (
              <span className="text-muted-foreground"> · {props.etiquetaPapelera(fila)}</span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              Inactivo
            </span>
            <span className="text-xs text-muted-foreground">v{fila.version}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={props.cambiandoEstado}
              onClick={() => props.onRestaurar(fila)}
            >
              Restaurar
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---- shared section (form + table + trash) ----

function SeccionCatalogo(
  props: Readonly<{
    titulo: string;
    tituloNuevo: string;
    descripcion: string;
    campos: CamposCatalogo;
    municipios?: MunicipioDoc[];
    activos: FilaCatalogo[];
    papelera: FilaCatalogo[];
    cargandoPapelera: boolean;
    guardando: boolean;
    cambiandoEstado: boolean;
    onGuardar: (valores: ValoresFormulario, objetivo: FilaCatalogo | null) => Promise<void>;
    onSetEstado: (fila: FilaCatalogo, estado: boolean) => void;
  }>,
) {
  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState<FilaCatalogo | null>(null);
  const [nombre, setNombre] = useState("");
  const [fkMunicipio, setFkMunicipio] = useState("");
  const [tipo, setTipo] = useState("");
  const [abreviatura, setAbreviatura] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, setPendiente] = useState<{
    accion: "desactivar" | "restaurar";
    fila: FilaCatalogo;
  } | null>(null);

  const municipioPorId = new Map((props.municipios ?? []).map((m) => [m.id, m.nombre] as const));

  // Closes the dialog and clears the form (also runs after a CONFIRMED save).
  const cancelar = (): void => {
    setAbierto(false);
    setEditando(null);
    setNombre("");
    setFkMunicipio("");
    setTipo("");
    setAbreviatura("");
    setError(null);
  };

  const iniciarCreacion = (): void => {
    setEditando(null);
    setNombre("");
    setFkMunicipio("");
    setTipo("");
    setAbreviatura("");
    setError(null);
    setAbierto(true);
  };

  const iniciarEdicion = (fila: FilaCatalogo): void => {
    setEditando(fila);
    setNombre(fila.nombre);
    setFkMunicipio(fila.fkMunicipio ?? "");
    setTipo(fila.tipo ?? "");
    setAbreviatura(fila.abreviatura ?? "");
    setError(null);
    setAbierto(true);
  };

  const desactivar = (fila: FilaCatalogo): void => {
    setPendiente({ accion: "desactivar", fila });
  };

  const restaurar = (fila: FilaCatalogo): void => {
    setPendiente({ accion: "restaurar", fila });
  };

  const enviar = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (enviando || props.guardando) return;
    const nombreTrim = nombre.trim();
    if (!nombreTrim) {
      setError("El nombre es obligatorio.");
      return;
    }
    if (props.campos === "municipio" && !editando && !fkMunicipio) {
      setError("Selecciona un municipio.");
      return;
    }
    setError(null);
    setEnviando(true);
    void props
      .onGuardar(
        {
          nombre: nombreTrim,
          ...(props.campos === "municipio" ? { fkMunicipio } : {}),
          ...(props.campos === "unidad" ? { tipo, abreviatura } : {}),
        },
        editando,
      )
      .then(() => {
        // The form clears only after the server CONFIRMS; the table row itself
        // updates when PULL delivers the new server state.
        cancelar();
      })
      .catch((error: unknown) => {
        // Surface the server error next to the fields too (the parent mutation's
        // onError still toasts it); keep the values so the user can fix them.
        setError(error instanceof Error ? error.message : "No se pudo guardar el cambio.");
      })
      .finally(() => setEnviando(false));
  };

  const columnas = 1 + (props.campos === "nombre" ? 0 : 1) + 1 + 1 + 1;

  const detalle = (fila: FilaCatalogo): string => {
    if (props.campos === "municipio") {
      return municipioPorId.get(fila.fkMunicipio ?? "") ?? "Municipio sin sincronizar";
    }
    if (props.campos === "unidad") {
      const partes = [fila.tipo ?? "", fila.abreviatura ?? ""].filter(Boolean);
      return partes.length > 0 ? partes.join(" · ") : "—";
    }
    return "";
  };

  const etiquetaPapelera = (fila: FilaCatalogo): string => {
    if (props.campos === "municipio") {
      return municipioPorId.get(fila.fkMunicipio ?? "") ?? "Municipio inactivo o sin sincronizar";
    }
    return "";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.titulo}</CardTitle>
        <CardDescription>{props.descripcion}</CardDescription>
        <CardAction>
          <Button onClick={iniciarCreacion}>{props.tituloNuevo}</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormDialog
          open={abierto}
          onOpenChange={(open) => {
            if (!open) cancelar();
          }}
          titulo={editando ? `Editar: ${editando.nombre}` : props.tituloNuevo}
          descripcion={editando ? "Modifica los datos y guarda los cambios." : props.descripcion}
          guardando={enviando || props.guardando}
          puedeGuardar={
            Boolean(nombre.trim()) &&
            (props.campos !== "municipio" || editando !== null || fkMunicipio !== "")
          }
          etiquetaGuardar={editando ? "Guardar cambios" : "Crear"}
          onSubmit={enviar}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`catalogo-nombre-${props.campos}`}>Nombre</Label>
              <Input
                id={`catalogo-nombre-${props.campos}`}
                value={nombre}
                onChange={(event) => setNombre(event.target.value)}
                placeholder="Nombre"
              />
            </div>
            {props.campos === "municipio" && (
              <div className="space-y-1.5">
                <Label htmlFor="catalogo-municipio">Municipio</Label>
                <select
                  id="catalogo-municipio"
                  value={fkMunicipio}
                  onChange={(event) => setFkMunicipio(event.target.value)}
                  className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
                >
                  <option value="" disabled>
                    Seleccione un municipio…
                  </option>
                  {(props.municipios ?? []).map((municipio) => (
                    <option key={municipio.id} value={municipio.id}>
                      {municipio.nombre}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {props.campos === "unidad" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="catalogo-unidad-tipo">Tipo (opcional)</Label>
                  <Input
                    id="catalogo-unidad-tipo"
                    value={tipo}
                    onChange={(event) => setTipo(event.target.value)}
                    placeholder="Tipo de unidad"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="catalogo-unidad-abreviatura">Abreviatura (opcional)</Label>
                  <Input
                    id="catalogo-unidad-abreviatura"
                    value={abreviatura}
                    onChange={(event) => setAbreviatura(event.target.value)}
                    placeholder="Abreviatura"
                  />
                </div>
              </>
            )}
          </div>
          {error != null && <FormError>{error}</FormError>}
        </FormDialog>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Nombre</th>
                {props.campos !== "nombre" && (
                  <th className="py-1 pr-3 font-medium">
                    {props.campos === "municipio" ? "Municipio" : "Detalle"}
                  </th>
                )}
                <th className="py-1 pr-3 font-medium">Estado</th>
                <th className="py-1 pr-3 font-medium">Versión</th>
                <th className="py-1 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {props.activos.map((fila) => (
                <tr key={fila.id} className="border-t">
                  <td className="py-1.5 pr-3">{fila.nombre}</td>
                  {props.campos !== "nombre" && (
                    <td className="py-1.5 pr-3 text-muted-foreground">{detalle(fila)}</td>
                  )}
                  <td className="py-1.5 pr-3">
                    <span className="rounded-full border px-2 py-0.5 text-xs text-emerald-600">
                      Activo
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{fila.version}</td>
                  <td className="flex gap-1 py-1.5">
                    <Button variant="outline" size="sm" onClick={() => iniciarEdicion(fila)}>
                      Editar
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={props.cambiandoEstado}
                      onClick={() => desactivar(fila)}
                    >
                      Desactivar
                    </Button>
                  </td>
                </tr>
              ))}
              {props.activos.length === 0 && (
                <tr>
                  <td colSpan={columnas} className="py-2 text-muted-foreground">
                    Sin registros sincronizados todavía.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="text-sm font-medium">Papelera</h3>
          <p className="mb-2 text-xs text-muted-foreground">
            Los registros desactivados se conservan y pueden restaurarse. No existe borrado
            permanente.
          </p>
          <ContenidoPapelera
            cargando={props.cargandoPapelera}
            papelera={props.papelera}
            campos={props.campos}
            cambiandoEstado={props.cambiandoEstado}
            etiquetaPapelera={etiquetaPapelera}
            onRestaurar={restaurar}
          />
        </div>

        {pendiente && (
          <ConfirmDialog
            open
            onOpenChange={(open) => {
              if (!open) setPendiente(null);
            }}
            title={
              pendiente.accion === "desactivar"
                ? `¿Desactivar "${pendiente.fila.nombre}"?`
                : `¿Restaurar "${pendiente.fila.nombre}"?`
            }
            description={
              pendiente.accion === "desactivar"
                ? "Pasará a la papelera."
                : "Volverá a estar activo."
            }
            confirmLabel={pendiente.accion === "desactivar" ? "Desactivar" : "Restaurar"}
            destructive={pendiente.accion === "desactivar"}
            onConfirm={() => {
              props.onSetEstado(pendiente.fila, pendiente.accion === "restaurar");
              setPendiente(null);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
