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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRxQuery } from "rxdb/plugins/react";
import type { MangoQuery } from "rxdb/plugins/core";
import { toast } from "sonner";

import { ENV } from "@/env";
import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import {
  type ImagenDoc,
  type ProductoDoc,
  type RassaDatabase,
  type CategoriaDoc,
  type UnidadDoc,
} from "@/lib/rxdb/database";
import { startReplications, type ReplicationSet } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { trpc } from "@/utils/trpc";

/**
 * P0 Productos — online admin CRUD for the master catalog (docs/scope.md §3.1, Q-19:
 * producto maestro = CRUD exclusivo Admin). Same architecture as /catalogos: writes are
 * online-confirm tRPC mutations, RxDB live queries are the read source, PULL delivers
 * the confirmed server state (reSync right after a mutation). Images upload base64 to
 * productos.imagenes.upload (D-1 local storage driver in dev) and render from the
 * served URL (ENV.VITE_SERVER_URL + doc.url).
 */

const SERVER_URL = ENV.VITE_SERVER_URL.replace(/\/$/, "");
const MAX_BYTES = 5 * 1024 * 1024;
const MIME_PERMITIDOS = new Set(["image/png", "image/jpeg", "image/webp"]);

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
const UNIDADES_QUERY: MangoQuery<UnidadDoc> = { sort: [{ nombre: "asc" }] };

function ProductosRoute() {
  const session = useSession();
  if (session.user?.rol !== "Admin") {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Solo Admin</CardTitle>
            <CardDescription>Solo el rol Admin puede administrar los productos.</CardDescription>
          </CardHeader>
        </Card>
      </div>
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
    <div className="container mx-auto max-w-4xl space-y-6 px-4 py-4">
      <div>
        <h1 className="text-xl font-semibold">Administración de productos</h1>
        <p className="text-sm text-muted-foreground">
          Catálogo maestro (Q-19: solo Admin). Los cambios se confirman en línea contra el servidor
          y llegan a todos los clientes mediante replicación (PULL).
        </p>
      </div>
      <SeccionProductos db={db} resincronizar={resincronizar} />
    </div>
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

function SeccionProductos({
  db,
  resincronizar,
}: Readonly<{ db: RassaDatabase; resincronizar: () => void }>) {
  const queryClient = useQueryClient();
  const activos = useRxQuery<ProductoDoc>({ collection: db.productos, query: PRODUCTOS_QUERY });
  const imagenes = useRxQuery<ImagenDoc>({ collection: db.imagenes, query: IMAGENES_QUERY });
  const categorias = useRxQuery<CategoriaDoc>({
    collection: db.categorias,
    query: CATEGORIAS_QUERY,
  });
  const unidades = useRxQuery<UnidadDoc>({ collection: db.unidades, query: UNIDADES_QUERY });
  const papelera = useQuery(trpc.productos.list.queryOptions({ incluirInactivos: true }));

  const crear = useMutation(
    trpc.productos.create.mutationOptions({
      onSuccess: () => notificarExito("Producto creado", queryClient, resincronizar),
      onError: (error) => toast.error(error.message),
    }),
  );
  const actualizar = useMutation(
    trpc.productos.update.mutationOptions({
      onSuccess: () => notificarExito("Producto actualizado", queryClient, resincronizar),
      onError: (error) => toast.error(error.message),
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
      onError: (error) => toast.error(error.message),
    }),
  );
  const subirImagen = useMutation(
    trpc.productos.imagenes.upload.mutationOptions({
      onSuccess: () => notificarExito("Imagen subida", queryClient, resincronizar),
      onError: (error) => toast.error(error.message),
    }),
  );
  const cambiarPrincipal = useMutation(
    trpc.productos.imagenes.setPrincipal.mutationOptions({
      onSuccess: () => notificarExito("Imagen principal actualizada", queryClient, resincronizar),
      onError: (error) => toast.error(error.message),
    }),
  );
  const eliminarImagen = useMutation(
    trpc.productos.imagenes.delete.mutationOptions({
      onSuccess: () => notificarExito("Imagen eliminada", queryClient, resincronizar),
      onError: (error) => toast.error(error.message),
    }),
  );

  const docsCategorias = categorias.results.map((doc) => doc.toJSON() as CategoriaDoc);
  const docsUnidades = unidades.results.map((doc) => doc.toJSON() as UnidadDoc);
  const imagenesPorProducto = new Map<string, ImagenDoc[]>();
  for (const doc of imagenes.results) {
    const imagen = doc.toJSON() as ImagenDoc;
    if (!imagen.fkProducto) continue;
    const lista = imagenesPorProducto.get(imagen.fkProducto) ?? [];
    lista.push(imagen);
    imagenesPorProducto.set(imagen.fkProducto, lista);
  }

  const [editando, setEditando] = useState<ProductoDoc | null>(null);
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [fkCategoria, setFkCategoria] = useState("");
  const [fkUnidad, setFkUnidad] = useState("");
  const [panelId, setPanelId] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const cancelar = (): void => {
    setEditando(null);
    setNombre("");
    setDescripcion("");
    setFkCategoria("");
    setFkUnidad("");
  };

  const iniciarEdicion = (fila: ProductoDoc): void => {
    setEditando(fila);
    setNombre(fila.nombre);
    setDescripcion(fila.descripcion ?? "");
    setFkCategoria(fila.fkCategoria);
    setFkUnidad(fila.fkUnidad ?? "");
  };

  const enviar = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nombreTrim = nombre.trim();
    if (!nombreTrim || !fkCategoria || enviando || crear.isPending || actualizar.isPending) return;
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
      .catch(() => {
        // Error toast handled by the parent mutation's onError; keep the values.
      })
      .finally(() => setEnviando(false));
  };

  const desactivar = (fila: ProductoDoc): void => {
    if (!window.confirm(`¿Desactivar "${fila.nombre}"? Pasará a la papelera.`)) return;
    cambiarEstado.mutate({ id: fila.id, version: fila.version, estado: false });
  };

  const restaurar = (fila: { id: string; nombre: string; version: number }): void => {
    if (!window.confirm(`¿Restaurar "${fila.nombre}"? Volverá a estar activo.`)) return;
    cambiarEstado.mutate({ id: fila.id, version: fila.version, estado: true });
  };

  const nombreCategoria = new Map(docsCategorias.map((c) => [c.id, c.nombre] as const));
  const nombreUnidad = new Map(
    docsUnidades.map((u) => [u.id, u.nombre ?? u.tipo ?? u.abreviatura ?? "—"] as const),
  );

  // ---- image upload (file input → base64 → productos.imagenes.upload) ----
  const subirArchivo = async (fkProducto: string, archivo: File): Promise<void> => {
    if (!MIME_PERMITIDOS.has(archivo.type)) {
      toast.error("Formato no permitido: usa PNG, JPG o WebP");
      return;
    }
    if (archivo.size > MAX_BYTES) {
      toast.error("La imagen supera el tamaño máximo de 5 MiB");
      return;
    }
    const dataUrl = await new Promise<string>((resolver, rechazar) => {
      const reader = new FileReader();
      reader.onload = () => resolver(reader.result as string);
      reader.onerror = () => rechazar(reader.error);
      reader.readAsDataURL(archivo);
    });
    const dataBase64 = dataUrl.split(",")[1] ?? "";
    await subirImagen.mutateAsync({
      fkProducto,
      fileName: archivo.name,
      mimeType: archivo.type as "image/png" | "image/jpeg" | "image/webp",
      dataBase64,
    });
  };

  const productoPanel = panelId
    ? (activos.results.find((d) => d.toJSON().id === panelId) ?? null)
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Productos</CardTitle>
        <CardDescription>
          Catálogo maestro con categoría, unidad e imágenes. El precio vigente vive en la oferta
          semanal (fuera de este módulo).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={enviar} className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">
            {editando ? `Editar: ${editando.nombre}` : "Nuevo producto"}
          </p>
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
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
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
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
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
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={
                enviando ||
                crear.isPending ||
                actualizar.isPending ||
                !nombre.trim() ||
                !fkCategoria
              }
            >
              {enviando || crear.isPending || actualizar.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : editando ? (
                "Guardar cambios"
              ) : (
                "Crear"
              )}
            </Button>
            {editando && (
              <Button type="button" variant="outline" onClick={cancelar}>
                Cancelar
              </Button>
            )}
          </div>
        </form>

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
                        <img
                          src={`${SERVER_URL}${principal.url}`}
                          alt={`Imagen principal de ${fila.nombre}`}
                          className="h-8 w-8 rounded object-cover"
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
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPanelId(panelId === fila.id ? null : fila.id)}
                      >
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

        {productoPanel && (
          <PanelImagenes
            producto={productoPanel.toJSON() as ProductoDoc}
            imagenes={imagenesPorProducto.get(productoPanel.toJSON().id) ?? []}
            subiendo={subirImagen.isPending}
            cambiando={cambiarPrincipal.isPending || eliminarImagen.isPending}
            onSubir={(archivo) => void subirArchivo(productoPanel.toJSON().id, archivo)}
            onSetPrincipal={(imagen) =>
              cambiarPrincipal.mutate({ id: imagen.id, version: imagen.version })
            }
            onEliminar={(imagen) => {
              if (!window.confirm("¿Eliminar esta imagen? Se borra definitivamente.")) return;
              eliminarImagen.mutate({ id: imagen.id, version: imagen.version });
            }}
          />
        )}

        <div>
          <h3 className="text-sm font-medium">Papelera</h3>
          <p className="mb-2 text-xs text-muted-foreground">
            Los productos desactivados se conservan (soft-delete) y pueden restaurarse. No existe
            borrado permanente.
          </p>
          {papelera.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (papelera.data ?? []).filter((fila) => !fila.estado).length === 0 ? (
            <p className="text-xs text-muted-foreground">La papelera está vacía.</p>
          ) : (
            <ul className="space-y-1">
              {(papelera.data ?? [])
                .filter((fila) => !fila.estado)
                .map((fila) => (
                  <li
                    key={fila.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2"
                  >
                    <span className="text-sm">{fila.nombre}</span>
                    <span className="flex items-center gap-2">
                      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        Inactivo
                      </span>
                      <span className="text-xs text-muted-foreground">v{fila.version}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cambiarEstado.isPending}
                        onClick={() => restaurar(fila)}
                      >
                        Restaurar
                      </Button>
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

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
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Imágenes de {props.producto.nombre} ({props.imagenes.length})
        </p>
        <Label
          htmlFor="producto-imagen-archivo"
          className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1 text-sm font-medium hover:bg-accent"
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
      </div>
      {props.imagenes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Este producto aún no tiene imágenes.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {props.imagenes.map((imagen) => (
            <li key={imagen.id} className="w-32 space-y-1 rounded-md border p-2">
              <img
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
