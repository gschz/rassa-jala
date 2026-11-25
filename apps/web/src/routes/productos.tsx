import { Button } from "@rassa-jala/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@rassa-jala/ui/components/dialog";
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

import { getServerUrl } from "@/lib/server-url";
import { subirImagenMultipart } from "@/lib/imagen-upload";
import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import {
  type ImagenDoc,
  type ProductoDoc,
  type RassaDatabase,
  type CategoriaDoc,
} from "@/lib/rxdb/database";
import { startReplications, type ReplicationSet } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { PageContainer } from "@/components/page-header";
import { FormError } from "@/components/form-error";
import { FormDialog } from "@/components/form-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ProductImage } from "@/components/product-image";
import { SkeletonTable } from "@/components/skeleton";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/**
 * P0 Productos — online admin CRUD for the master catalog (docs/scope.md §3.1, Q-19:
 * producto maestro = CRUD exclusivo Admin). Same architecture as /catalogos: writes are
 * online-confirm tRPC mutations, RxDB live queries are the read source, PULL delivers
 * the confirmed server state (reSync right after a mutation). Images upload multipart
 * (POST /upload/imagenes → the same productos.imagenes.upload procedure server-side;
 * D-1 local storage driver in dev) and render from the served URL
 * (ENV.VITE_SERVER_URL + doc.url).
 */

const SERVER_URL = getServerUrl();

// Pending confirmation behind the ConfirmDialog gate (replaces the native confirm dialog).
type AccionPendiente =
  | { accion: "desactivar"; fila: ProductoDoc }
  | { accion: "restaurar"; fila: { id: string; nombre: string; version: number } }
  | { accion: "eliminarImagen"; imagen: ImagenDoc };

function confirmacionDe(pendiente: AccionPendiente): {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
} {
  switch (pendiente.accion) {
    case "desactivar":
      return {
        title: `¿Desactivar "${pendiente.fila.nombre}"?`,
        description: "Pasará a la papelera.",
        confirmLabel: "Desactivar",
        destructive: true,
      };
    case "restaurar":
      return {
        title: `¿Restaurar "${pendiente.fila.nombre}"?`,
        description: "Volverá a estar activo.",
        confirmLabel: "Restaurar",
        destructive: false,
      };
    case "eliminarImagen":
      return {
        title: "¿Eliminar esta imagen?",
        description: "Se borra definitivamente.",
        confirmLabel: "Eliminar",
        destructive: true,
      };
  }
}

export const Route = createFileRoute("/productos")({
  // Protected route (same contract as /): token or one silent refresh.
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: ProductosRoute,
});

// Stable query objects: a new object identity every render would make the
// live-query hooks resubscribe on every render.
const PRODUCTOS_QUERY: MangoQuery<ProductoDoc> = { sort: [{ nombre: "asc" }] };
const IMAGENES_QUERY: MangoQuery<ImagenDoc> = { sort: [{ orden: "asc" }] };
const CATEGORIAS_QUERY: MangoQuery<CategoriaDoc> = { sort: [{ nombre: "asc" }] };

function ProductosRoute() {
  const session = useSession();
  if (session.user?.rol !== "Admin") {
    return (
      <PageContainer>
        <Card>
          <CardHeader>
            <CardTitle>Solo Admin</CardTitle>
            <CardDescription>Solo el rol Admin puede administrar los productos.</CardDescription>
          </CardHeader>
        </Card>
      </PageContainer>
    );
  }
  return <ProductosAdmin />;
}

function ProductosAdmin() {
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
        <SkeletonTable rows={5} />
      </PageContainer>
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
        <h1 className="text-xl font-semibold">Productos</h1>
        <p className="text-sm text-muted-foreground">
          Catálogo maestro. Los cambios se confirman en línea contra el servidor y se sincronizan
          con todos los dispositivos.
        </p>
      </div>
      <SeccionProductos db={db} resincronizar={resincronizar} />
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

interface PapeleraProductosProps {
  cargando: boolean;
  items: Array<{ id: string; nombre: string; version: number; estado: boolean }>;
  cambiandoEstado: boolean;
  onRestaurar: (fila: { id: string; nombre: string; version: number }) => void;
}

function PapeleraProductos({
  cargando,
  items,
  cambiandoEstado,
  onRestaurar,
}: PapeleraProductosProps) {
  if (cargando) {
    return <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;
  }
  const inactivos = items.filter((f) => !f.estado);
  if (inactivos.length === 0) {
    return <p className="text-xs text-muted-foreground">La papelera está vacía.</p>;
  }
  return (
    <ul className="space-y-1">
      {inactivos.map((fila) => (
        <li key={fila.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
          <span className="text-sm">{fila.nombre}</span>
          <span className="flex items-center gap-2">
            <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              Inactivo
            </span>
            <span className="text-xs text-muted-foreground">v{fila.version}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={cambiandoEstado}
              onClick={() => onRestaurar(fila)}
            >
              Restaurar
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function SeccionProductos({
  db,
  resincronizar,
}: Readonly<{ db: RassaDatabase; resincronizar: () => void }>) {
  const queryClient = useQueryClient();
  const activos = useRxQueryLive<ProductoDoc>({
    collection: db.productos,
    query: PRODUCTOS_QUERY,
  });
  const imagenes = useRxQueryLive<ImagenDoc>({
    collection: db.imagenes,
    query: IMAGENES_QUERY,
  });
  const categorias = useRxQueryLive<CategoriaDoc>({
    collection: db.categorias,
    query: CATEGORIAS_QUERY,
  });
  const unidades = useQuery(trpc.catalogos.unidadesList.queryOptions({}));
  const papelera = useQuery(trpc.productos.list.queryOptions({ incluirInactivos: true }));

  const crear = useMutation(
    trpc.productos.create.mutationOptions({
      onSuccess: () => notificarExito("Producto creado", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const actualizar = useMutation(
    trpc.productos.update.mutationOptions({
      onSuccess: () => notificarExito("Producto actualizado", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const cambiarEstado = useMutation(
    trpc.productos.setEstado.mutationOptions({
      onSuccess: (_, variables) =>
        notificarExito(
          variables.estado ? "Producto restaurado" : "Producto desactivado",
          queryClient,
          resincronizar,
        ),
      onError: (error) => notificarError(error),
    }),
  );
  const subirImagen = useMutation({
    mutationFn: (v: { fkProducto: string; archivo: File }) =>
      subirImagenMultipart({ tipo: "producto", fkProducto: v.fkProducto }, v.archivo),
    onSuccess: () => notificarExito("Imagen subida", queryClient, resincronizar),
    onError: (error) => notificarError(error),
  });
  const cambiarPrincipal = useMutation(
    trpc.productos.imagenes.setPrincipal.mutationOptions({
      onSuccess: () => notificarExito("Imagen principal actualizada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const eliminarImagen = useMutation(
    trpc.productos.imagenes.delete.mutationOptions({
      onSuccess: () => notificarExito("Imagen eliminada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );

  const docsCategorias = categorias.results.map((doc) => doc.toJSON() as CategoriaDoc);
  const docsUnidades = unidades.data ?? [];
  const imagenesPorProducto = new Map<string, ImagenDoc[]>();
  for (const doc of imagenes.results) {
    const imagen = doc.toJSON() as ImagenDoc;
    if (!imagen.fkProducto) continue;
    const lista = imagenesPorProducto.get(imagen.fkProducto) ?? [];
    lista.push(imagen);
    imagenesPorProducto.set(imagen.fkProducto, lista);
  }

  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState<ProductoDoc | null>(null);
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [fkCategoria, setFkCategoria] = useState("");
  const [fkUnidad, setFkUnidad] = useState("");
  const [panelId, setPanelId] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, setPendiente] = useState<AccionPendiente | null>(null);

  // Closes the dialog and clears the form (also runs after a CONFIRMED save).
  const cancelar = (): void => {
    setAbierto(false);
    setEditando(null);
    setNombre("");
    setDescripcion("");
    setFkCategoria("");
    setFkUnidad("");
    setError(null);
  };

  const iniciarCreacion = (): void => {
    setEditando(null);
    setNombre("");
    setDescripcion("");
    setFkCategoria("");
    setFkUnidad("");
    setError(null);
    setAbierto(true);
  };

  const iniciarEdicion = (fila: ProductoDoc): void => {
    setEditando(fila);
    setNombre(fila.nombre);
    setDescripcion(fila.descripcion ?? "");
    setFkCategoria(fila.fkCategoria);
    setFkUnidad(fila.fkUnidad ?? "");
    setError(null);
    setAbierto(true);
  };

  const enviar = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (enviando || crear.isPending || actualizar.isPending) return;
    const nombreTrim = nombre.trim();
    if (!nombreTrim) {
      setError("El nombre es obligatorio.");
      return;
    }
    if (!fkCategoria) {
      setError("Selecciona una categoría.");
      return;
    }
    setError(null);
    setEnviando(true);
    // Send FKs only when they actually changed: an unchanged parent avoids rejecting
    // edits of productos whose categoria/unidad is inactive (server validates FKs it
    // receives, same contract as catalogos localidades). null clears the unidad.
    const cambioUnidad = fkUnidad !== (editando?.fkUnidad ?? "");
    const valores = {
      nombre: nombreTrim,
      descripcion: descripcion.trim() || null,
      fkCategoria,
    };
    const promesa = editando
      ? actualizar.mutateAsync({
          id: editando.id,
          version: editando.version,
          ...valores,
          fkCategoria:
            valores.fkCategoria === editando.fkCategoria ? undefined : valores.fkCategoria,
          ...(cambioUnidad ? { fkUnidad: fkUnidad || null } : {}),
        })
      : crear.mutateAsync({
          ...valores,
          ...(fkUnidad ? { fkUnidad } : {}),
        });
    void promesa
      .then(() => {
        // The form clears only after the server CONFIRMS; the table row itself
        // updates when PULL delivers the new server state.
        cancelar();
      })
      .catch((error: unknown) => {
        // Surface the server error next to the fields too (the parent mutation's
        // onError still toasts it); keep the values so the user can fix them.
        setError(error instanceof Error ? error.message : "No se pudo guardar el producto.");
      })
      .finally(() => setEnviando(false));
  };

  const desactivar = (fila: ProductoDoc): void => {
    setPendiente({ accion: "desactivar", fila });
  };

  const restaurar = (fila: { id: string; nombre: string; version: number }): void => {
    setPendiente({ accion: "restaurar", fila });
  };

  const nombreCategoria = new Map(docsCategorias.map((c) => [c.id, c.nombre] as const));
  const nombreUnidad = new Map(
    docsUnidades.map((u) => [u.id, u.nombre ?? u.tipo ?? u.abreviatura ?? "—"] as const),
  );

  // ---- image upload (file input → multipart POST /upload/imagenes) ----
  const subirArchivo = async (fkProducto: string, archivo: File): Promise<void> => {
    await subirImagen.mutateAsync({ fkProducto, archivo });
  };

  const productoPanel = panelId
    ? (activos.results.find((d) => d.toJSON().id === panelId) ?? null)
    : null;
  const productoPanelDoc = productoPanel ? (productoPanel.toJSON() as ProductoDoc) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Productos</CardTitle>
        <CardDescription>
          Catálogo maestro con categoría, unidad e imágenes. El precio vigente vive en la oferta
          semanal (fuera de este módulo).
        </CardDescription>
        <CardAction>
          <Button onClick={iniciarCreacion}>Nuevo producto</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormDialog
          open={abierto}
          onOpenChange={(open) => {
            if (!open) cancelar();
          }}
          titulo={editando ? `Editar: ${editando.nombre}` : "Nuevo producto"}
          descripcion={
            editando
              ? "Modifica los datos y guarda los cambios."
              : "Crea un producto del catálogo maestro."
          }
          guardando={enviando || crear.isPending || actualizar.isPending}
          puedeGuardar={Boolean(nombre.trim()) && fkCategoria !== ""}
          etiquetaGuardar={editando ? "Guardar cambios" : "Crear"}
          onSubmit={enviar}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="producto-nombre">Nombre</Label>
              <Input
                id="producto-nombre"
                value={nombre}
                onChange={(event) => setNombre(event.target.value)}
                placeholder="Nombre del producto"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="producto-descripcion">Descripción (opcional)</Label>
              <Input
                id="producto-descripcion"
                value={descripcion}
                onChange={(event) => setDescripcion(event.target.value)}
                placeholder="Descripción"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="producto-categoria">Categoría</Label>
              <select
                id="producto-categoria"
                value={fkCategoria}
                onChange={(event) => setFkCategoria(event.target.value)}
                className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                <option value="" disabled>
                  Seleccione una categoría…
                </option>
                {docsCategorias.map((categoria) => (
                  <option key={categoria.id} value={categoria.id}>
                    {categoria.nombre}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="producto-unidad">Unidad de medida (opcional)</Label>
              <select
                id="producto-unidad"
                value={fkUnidad}
                onChange={(event) => setFkUnidad(event.target.value)}
                className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                <option value="">(sin unidad)</option>
                {docsUnidades.map((unidad) => (
                  <option key={unidad.id} value={unidad.id}>
                    {nombreUnidad.get(unidad.id)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error != null && <FormError>{error}</FormError>}
        </FormDialog>

        {activos.loading ? (
          <SkeletonTable rows={5} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Nombre</th>
                  <th className="py-1 pr-3 font-medium">Categoría</th>
                  <th className="py-1 pr-3 font-medium">Unidad</th>
                  <th className="py-1 pr-3 font-medium">Imágenes</th>
                  <th className="py-1 pr-3 font-medium">Versión</th>
                  <th className="py-1 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {activos.results.map((doc) => {
                  const fila = doc.toJSON() as ProductoDoc;
                  const susImagenes = imagenesPorProducto.get(fila.id) ?? [];
                  const principal = susImagenes.find((i) => i.principal);
                  return (
                    <tr key={fila.id} className="border-t">
                      <td className="py-1.5 pr-3">{fila.nombre}</td>
                      <td className="py-1.5 pr-3 text-muted-foreground">
                        {nombreCategoria.get(fila.fkCategoria) ?? "—"}
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground">
                        {fila.fkUnidad ? (nombreUnidad.get(fila.fkUnidad) ?? "—") : "—"}
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground">
                        {principal ? (
                          <ProductImage
                            src={`${SERVER_URL}${principal.url}`}
                            alt={`Imagen principal de ${fila.nombre}`}
                            className="h-8 w-8 rounded object-cover"
                            iconClassName="size-3.5"
                          />
                        ) : (
                          <span>{susImagenes.length}</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground">{fila.version}</td>
                      <td className="flex gap-1 py-1.5">
                        <Button variant="outline" size="sm" onClick={() => iniciarEdicion(fila)}>
                          Editar
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setPanelId(fila.id)}>
                          Imágenes
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => desactivar(fila)}>
                          Desactivar
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {activos.results.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-2 text-muted-foreground">
                      Sin productos sincronizados todavía.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Images panel as a Dialog (same pattern as the mis-pedidos detail):
            opens per row, keeps the upload input, grid, setPrincipal and delete
            flows untouched; the ConfirmDialog gate for delete stays global. */}
        <Dialog
          open={productoPanelDoc !== null}
          onOpenChange={(open) => {
            if (!open) setPanelId(null);
          }}
        >
          {productoPanelDoc && (
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>
                  Imágenes de {productoPanelDoc.nombre} (
                  {imagenesPorProducto.get(productoPanelDoc.id)?.length ?? 0})
                </DialogTitle>
                <DialogDescription>
                  Sube fotos, define la principal y elimina las que ya no necesites.
                </DialogDescription>
              </DialogHeader>
              <PanelImagenes
                producto={productoPanelDoc}
                imagenes={imagenesPorProducto.get(productoPanelDoc.id) ?? []}
                subiendo={subirImagen.isPending}
                cambiando={cambiarPrincipal.isPending || eliminarImagen.isPending}
                onSubir={(archivo) => void subirArchivo(productoPanelDoc.id, archivo)}
                onSetPrincipal={(imagen) =>
                  cambiarPrincipal.mutate({ id: imagen.id, version: imagen.version })
                }
                onEliminar={(imagen) => setPendiente({ accion: "eliminarImagen", imagen })}
              />
            </DialogContent>
          )}
        </Dialog>

        <div>
          <h3 className="text-sm font-medium">Papelera</h3>
          <p className="mb-2 text-xs text-muted-foreground">
            Los productos desactivados se conservan y pueden restaurarse. No existe borrado
            permanente.
          </p>
          <PapeleraProductos
            cargando={papelera.isPending}
            items={papelera.data ?? []}
            cambiandoEstado={cambiarEstado.isPending}
            onRestaurar={restaurar}
          />
        </div>

        {pendiente && (
          <ConfirmDialog
            open
            onOpenChange={(open) => {
              if (!open) setPendiente(null);
            }}
            {...confirmacionDe(pendiente)}
            onConfirm={() => {
              if (pendiente.accion === "eliminarImagen") {
                eliminarImagen.mutate({
                  id: pendiente.imagen.id,
                  version: pendiente.imagen.version,
                });
              } else {
                cambiarEstado.mutate({
                  id: pendiente.fila.id,
                  version: pendiente.fila.version,
                  estado: pendiente.accion === "restaurar",
                });
              }
              setPendiente(null);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Content of the "Imágenes de X" Dialog: upload label (hidden file input keeps
 * its click → picker → onChange → multipart upload wiring) plus the photo grid
 * with principal/order actions. The DialogHeader owns the title/description.
 */
function PanelImagenes(
  props: Readonly<{
    producto: ProductoDoc;
    imagenes: ImagenDoc[];
    subiendo: boolean;
    cambiando: boolean;
    onSubir: (archivo: File) => void;
    onSetPrincipal: (imagen: ImagenDoc) => void;
    onEliminar: (imagen: ImagenDoc) => void;
  }>,
) {
  return (
    <div className="space-y-3">
      <Label
        htmlFor="producto-imagen-archivo"
        className="flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-1 text-sm font-medium hover:bg-accent"
      >
        {props.subiendo ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        Subir imagen (PNG, JPG o WebP · máx. 5 MiB)
        <input
          id="producto-imagen-archivo"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          disabled={props.subiendo}
          onChange={(event) => {
            const archivo = event.target.files?.[0];
            event.target.value = "";
            if (archivo) props.onSubir(archivo);
          }}
        />
      </Label>
      {props.imagenes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Este producto aún no tiene imágenes.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {props.imagenes.map((imagen) => (
            <li key={imagen.id} className="w-32 space-y-1 rounded-md border p-2">
              <ProductImage
                src={`${SERVER_URL}${imagen.url}`}
                alt={`Imagen ${imagen.orden + 1} de ${props.producto.nombre}`}
                className="h-20 w-full rounded object-cover"
              />
              <p className="text-center text-xs text-muted-foreground">
                {imagen.principal ? "Principal" : `#${imagen.orden + 1}`}
              </p>
              <div className="flex flex-col gap-1">
                {!imagen.principal && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={props.cambiando}
                    onClick={() => props.onSetPrincipal(imagen)}
                  >
                    Hacer principal
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={props.cambiando}
                  onClick={() => props.onEliminar(imagen)}
                >
                  Eliminar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
