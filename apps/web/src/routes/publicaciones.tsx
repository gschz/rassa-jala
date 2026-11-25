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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import type { MangoQuery } from "rxdb/plugins/core";
import { useRxQueryLive } from "@/lib/rxdb/use-live-query";
import { toast } from "sonner";

import { FormError } from "@/components/form-error";

import { subirImagenMultipart } from "@/lib/imagen-upload";
import { getServerUrl } from "@/lib/server-url";
import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import {
  type ImagenDoc,
  type ItemSemanalDoc,
  type ProductoDoc,
  type PublicacionDoc,
  type RassaDatabase,
} from "@/lib/rxdb/database";
import { startReplications, type ReplicationSet } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { PageContainer } from "@/components/page-header";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ProductImage } from "@/components/product-image";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";
import { aFechaCiclo, isoWeekFromMonday, mondayOfBusinessWeek } from "@rassa-jala/db/iso-semana";

/**
 * P0 Publicaciones semanales — Agricultor's weekly cycle (docs/scope.md §3.1, Q-25).
 *
 * Offline behavior (S2, docs/synchronization.md §9): draft create/edit/remove are LOCAL
 * RxDB writes — visible immediately and marked "Pendiente" (doc.syncOpId present) until
 * the push verdict + pull round-trip confirm them. Never shown as confirmed.
 * publish/cancelar/cerrar are ONLINE-CONFIRM tRPC mutations: the button is disabled
 * while offline and a not-yet-synced draft cannot be published (never a fake
 * confirmation). The server's exact Monday-gate error (America/Mazatlan) surfaces in
 * the toast when the publish attempt is rejected.
 *
 * Photos: online-only multipart upload (POST /upload/imagenes → the same
 * publicaciones.imagenes.upload procedure server-side; D-1 adapter, M-11
 * producto_imagen.fk_producto_semanal target).
 */

const ETIQUETA_ESTADO = {
  borrador: "Borrador",
  publicado: "Publicada",
  cancelado: "Cancelada",
  cerrado: "Cerrada",
} as const;

const COLOR_ESTADO: Record<string, string> = {
  borrador: "text-amber-600",
  publicado: "text-emerald-600",
  cancelado: "text-red-500",
  cerrado: "text-muted-foreground",
};

export const Route = createFileRoute("/publicaciones")({
  // Protected route (same contract as /): token or one silent refresh.
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: PublicacionesRoute,
});

// Stable query objects (avoid resubscribing live queries each render).
const PUBLICACIONES_QUERY: MangoQuery<PublicacionDoc> = {
  sort: [{ fechaCiclo: "desc" }, { id: "asc" }],
};
const ITEMS_QUERY: MangoQuery<ItemSemanalDoc> = { sort: [{ id: "asc" }] };
const PRODUCTOS_QUERY: MangoQuery<ProductoDoc> = { sort: [{ nombre: "asc" }] };
const IMAGENES_QUERY: MangoQuery<ImagenDoc> = { sort: [{ orden: "asc" }] };

function PublicacionesRoute() {
  const session = useSession();
  if (session.user?.rol !== "Agricultor" && session.user?.rol !== "Admin") {
    return (
      <PageContainer>
        <Card>
          <CardHeader>
            <CardTitle>Solo Agricultor</CardTitle>
            <CardDescription>
              Solo los roles Agricultor (o Admin) gestionan las publicaciones semanales.
            </CardDescription>
          </CardHeader>
        </Card>
      </PageContainer>
    );
  }
  return <PublicacionesPage />;
}

function PublicacionesPage() {
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

  const resincronizar = (): void => {
    repRef.current?.reSyncAll();
  };

  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Publicaciones</h1>
        <p className="text-sm text-muted-foreground">
          Tu oferta semanal por ciclo. Los borradores se editan sin conexión y se envían al servidor
          al reconectar; publicar/cancelar/cerrar requieren conexión.
        </p>
      </div>
      <PaginaPublicaciones db={db} resincronizar={resincronizar} />
    </PageContainer>
  );
}

// Money normalization WITHOUT float: pure string shaping (Q-14 — never Number for price).
function normalizarPrecio(entrada: string): string | null {
  const limpio = entrada.trim().replace(",", ".");
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(limpio)) return null;
  if (!limpio.includes(".")) return `${limpio}.00`;
  const [entero, decimales] = limpio.split(".");
  return `${entero}.${decimales.padEnd(2, "0")}`;
}

// Ciclo options for the draft picker: the current ciclo Monday and the next one (Q-25:
// the ciclo is its Monday date; legacy computed the NEXT Monday at creation).
function opcionesCiclo(): Array<{ valor: string; etiqueta: string }> {
  const lunes = mondayOfBusinessWeek(new Date());
  const siguiente = new Date(lunes);
  siguiente.setUTCDate(siguiente.getUTCDate() + 7);
  return [lunes, siguiente].map((fecha) => {
    const { semanaIso, anioIso } = isoWeekFromMonday(fecha);
    const valor = aFechaCiclo(fecha);
    return {
      valor,
      etiqueta: `Semana ${semanaIso} (${anioIso}) — lunes ${valor}`,
    };
  });
}

function PaginaPublicaciones({
  db,
  resincronizar,
}: Readonly<{ db: RassaDatabase; resincronizar: () => void }>) {
  const session = useSession();
  const queryClient = useQueryClient();
  const publicaciones = useRxQueryLive<PublicacionDoc>({
    collection: db.publicaciones,
    query: PUBLICACIONES_QUERY,
  });
  const items = useRxQueryLive<ItemSemanalDoc>({
    collection: db.itemsSemanales,
    query: ITEMS_QUERY,
  });
  const productos = useRxQueryLive<ProductoDoc>({
    collection: db.productos,
    query: PRODUCTOS_QUERY,
  });
  const imagenes = useRxQueryLive<ImagenDoc>({
    collection: db.imagenes,
    query: IMAGENES_QUERY,
  });

  const publicar = useMutation(
    trpc.publicaciones.publicar.mutationOptions({
      onSuccess: () => notificarExito("Publicación publicada", queryClient, resincronizar),
      // The exact server message (Monday gate, validations) surfaces verbatim.
      onError: (error) => notificarError(error),
    }),
  );
  const cancelar = useMutation(
    trpc.publicaciones.cancelar.mutationOptions({
      onSuccess: () => notificarExito("Publicación cancelada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const cerrar = useMutation(
    trpc.publicaciones.cerrar.mutationOptions({
      onSuccess: () => notificarExito("Publicación cerrada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const subirFoto = useMutation({
    mutationFn: (v: { fkProductoSemanal: string; archivo: File }) =>
      subirImagenMultipart({ tipo: "item", fkProductoSemanal: v.fkProductoSemanal }, v.archivo),
    onSuccess: () => notificarExito("Foto subida", queryClient, resincronizar),
    onError: (error) => notificarError(error),
  });
  const cambiarPrincipal = useMutation(
    trpc.publicaciones.imagenes.setPrincipal.mutationOptions({
      onSuccess: () => notificarExito("Foto principal actualizada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );
  const eliminarFoto = useMutation(
    trpc.publicaciones.imagenes.delete.mutationOptions({
      onSuccess: () => notificarExito("Foto eliminada", queryClient, resincronizar),
      onError: (error) => notificarError(error),
    }),
  );

  const [ciclo, setCiclo] = useState("");
  const [creando, setCreando] = useState(false);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [accionPendiente, setAccionPendiente] = useState<
    | { tipo: "cancelar"; pub: PublicacionDoc }
    | { tipo: "cerrar"; pub: PublicacionDoc }
    | { tipo: "eliminarFoto"; imagen: ImagenDoc }
    | null
  >(null);

  const docsPublicaciones = publicaciones.results.map((doc) => doc.toJSON() as PublicacionDoc);
  const docsItems = items.results.map((doc) => doc.toJSON() as ItemSemanalDoc);
  const itemsPorPublicacion = new Map<string, ItemSemanalDoc[]>();
  for (const item of docsItems) {
    const lista = itemsPorPublicacion.get(item.fkPublicacion) ?? [];
    lista.push(item);
    itemsPorPublicacion.set(item.fkPublicacion, lista);
  }

  // Local draft write: visible immediately, pending until the push verdict (syncOpId).
  const crearBorrador = async (): Promise<void> => {
    if (!session.user || creando) return;
    setCreando(true);
    const lunes = mondayOfBusinessWeek(new Date());
    const { semanaIso, anioIso } = isoWeekFromMonday(lunes);
    const doc: PublicacionDoc = {
      id: crypto.randomUUID(),
      fkAgricultor: session.user.id,
      fechaCiclo: ciclo || aFechaCiclo(lunes),
      semanaIso,
      anioIso,
      estado: "borrador",
      version: 0,
      actualizadoEn: new Date().toISOString(),
      syncOpId: crypto.randomUUID(),
    };
    await db.publicaciones
      .insert(doc)
      .then(() => {
        toast.success("Borrador creado localmente; se enviará al sincronizar");
        setCiclo("");
      })
      .catch(() => toast.error("No se pudo crear el borrador localmente."))
      .finally(() => setCreando(false));
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Nuevo borrador</CardTitle>
          <CardDescription>
            Se guarda en tu dispositivo y se confirma en el servidor al sincronizar. El ciclo
            siempre apunta a un lunes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
              event.preventDefault();
              void crearBorrador();
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="publicacion-ciclo">Ciclo (lunes)</Label>
              <select
                id="publicacion-ciclo"
                value={ciclo}
                onChange={(event) => setCiclo(event.target.value)}
                className="flex h-10 w-72 rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                <option value="">Semana actual (por defecto)</option>
                {opcionesCiclo().map((o) => (
                  <option key={o.valor} value={o.valor}>
                    {o.etiqueta}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={creando}>
              {creando ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                "Crear borrador"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {docsPublicaciones.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Sin publicaciones todavía. Crea tu primer borrador para el ciclo actual.
          </CardContent>
        </Card>
      ) : (
        docsPublicaciones.map((pub) => (
          <TarjetaPublicacion
            key={pub.id}
            db={db}
            publicacion={pub}
            items={itemsPorPublicacion.get(pub.id) ?? []}
            productos={productos.results.map((doc) => doc.toJSON() as ProductoDoc)}
            imagenes={imagenes.results.map((doc) => doc.toJSON() as ImagenDoc)}
            online={navigator.onLine}
            publicando={publicar.isPending}
            cancelando={cancelar.isPending}
            cerrando={cerrar.isPending}
            subiendo={subirFoto.isPending}
            cambiandoPrincipal={cambiarPrincipal.isPending}
            eliminandoFoto={eliminarFoto.isPending}
            abierto={panelId === pub.id}
            onTogglePanel={() => setPanelId(panelId === pub.id ? null : pub.id)}
            onPublicar={() => publicar.mutate({ publicacionId: pub.id, version: pub.version })}
            onCancelar={() => setAccionPendiente({ tipo: "cancelar", pub })}
            onCerrar={() => setAccionPendiente({ tipo: "cerrar", pub })}
            onSubirFoto={(fkItem, archivo) =>
              void subirFoto.mutateAsync({ fkProductoSemanal: fkItem, archivo })
            }
            onSetPrincipal={(imagen) =>
              cambiarPrincipal.mutate({ id: imagen.id, version: imagen.version })
            }
            onEliminarFoto={(imagen) => setAccionPendiente({ tipo: "eliminarFoto", imagen })}
          />
        ))
      )}

      {accionPendiente && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setAccionPendiente(null);
          }}
          title={
            accionPendiente.tipo === "cancelar"
              ? "¿Cancelar la publicación?"
              : accionPendiente.tipo === "cerrar"
                ? "¿Cerrar la publicación?"
                : "¿Eliminar la foto?"
          }
          description={
            accionPendiente.tipo === "eliminarFoto"
              ? "Se eliminará la foto del artículo de forma permanente."
              : `Se ${
                  accionPendiente.tipo === "cancelar" ? "cancelará" : "cerrará"
                } la publicación del ciclo ${accionPendiente.pub.fechaCiclo}.`
          }
          confirmLabel={
            accionPendiente.tipo === "cancelar"
              ? "Cancelar publicación"
              : accionPendiente.tipo === "cerrar"
                ? "Cerrar publicación"
                : "Eliminar foto"
          }
          destructive
          onConfirm={() => {
            if (accionPendiente.tipo === "cancelar") {
              cancelar.mutate({
                publicacionId: accionPendiente.pub.id,
                version: accionPendiente.pub.version,
              });
            } else if (accionPendiente.tipo === "cerrar") {
              cerrar.mutate({
                publicacionId: accionPendiente.pub.id,
                version: accionPendiente.pub.version,
              });
            } else {
              eliminarFoto.mutate({
                id: accionPendiente.imagen.id,
                version: accionPendiente.imagen.version,
              });
            }
            setAccionPendiente(null);
          }}
        />
      )}
    </>
  );
}

/** Shared success feedback: toast now, refresh queries, pull the new state. */
function notificarExito(
  mensaje: string,
  queryClient: ReturnType<typeof useQueryClient>,
  resincronizar: () => void,
): void {
  toast.success(mensaje);
  void queryClient.invalidateQueries();
  resincronizar();
}

function determinarTituloPublicar(
  online: boolean,
  pendiente: boolean,
  esBorrador: boolean,
): string | undefined {
  if (!online) return "Requiere conexión";
  if (pendiente) return "Pendiente de sincronizar";
  if (!esBorrador) return "Solo los borradores se publican";
  return undefined;
}

function BotonPublicar({
  puedePublicar,
  online,
  pendiente,
  esBorrador,
  publicando,
  onPublicar,
}: {
  puedePublicar: boolean;
  online: boolean;
  pendiente: boolean;
  esBorrador: boolean;
  publicando: boolean;
  onPublicar: () => void;
}) {
  return (
    <Button
      size="sm"
      disabled={!puedePublicar}
      title={determinarTituloPublicar(online, pendiente, esBorrador)}
      onClick={onPublicar}
    >
      {publicando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      Publicar
    </Button>
  );
}

function TarjetaPublicacion(
  props: Readonly<{
    db: RassaDatabase;
    publicacion: PublicacionDoc;
    items: ItemSemanalDoc[];
    productos: ProductoDoc[];
    imagenes: ImagenDoc[];
    online: boolean;
    publicando: boolean;
    cancelando: boolean;
    cerrando: boolean;
    subiendo: boolean;
    cambiandoPrincipal: boolean;
    eliminandoFoto: boolean;
    abierto: boolean;
    onTogglePanel: () => void;
    onPublicar: () => void;
    onCancelar: () => void;
    onCerrar: () => void;
    onSubirFoto: (fkItem: string, archivo: File) => void;
    onSetPrincipal: (imagen: ImagenDoc) => void;
    onEliminarFoto: (imagen: ImagenDoc) => void;
  }>,
) {
  const { db, publicacion: pub } = props;
  const itemsActivos = props.items.filter((i) => i.estado === "activo");
  const itemsInactivos = props.items.filter((i) => i.estado === "inactivo");
  const esBorrador = pub.estado === "borrador";
  // A draft not yet confirmed by the server (syncOpId present) cannot be published:
  // the server needs the row + the CAS version first (never a fake confirmation).
  const pendiente = pub.syncOpId != null;
  const puedePublicar = props.online && esBorrador && !pendiente && !props.publicando;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">
              Ciclo {pub.fechaCiclo} — semana {pub.semanaIso} de {pub.anioIso}
            </CardTitle>
            <CardDescription>
              {itemsActivos.length} artículo{itemsActivos.length === 1 ? "" : "s"} activo
              {itemsActivos.length === 1 ? "" : "s"}
              {pendiente ? " · pendiente de sincronizar" : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${COLOR_ESTADO[pub.estado] ?? ""}`}>
              {ETIQUETA_ESTADO[pub.estado as keyof typeof ETIQUETA_ESTADO] ?? pub.estado}
            </span>
            {pendiente && <span className="text-xs text-amber-500">Pendiente de sincronizar</span>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Producto</th>
                <th className="py-1 pr-3 font-medium">Precio</th>
                <th className="py-1 pr-3 font-medium">Stock</th>
                <th className="py-1 pr-3 font-medium">Foto</th>
                {esBorrador && <th className="py-1 font-medium">Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {itemsActivos.map((item) => (
                <FilaItem
                  key={item.id}
                  db={db}
                  item={item}
                  productos={props.productos}
                  imagenes={props.imagenes}
                  esBorrador={esBorrador}
                  online={props.online}
                  subiendo={props.subiendo}
                  cambiandoPrincipal={props.cambiandoPrincipal}
                  eliminandoFoto={props.eliminandoFoto}
                  onSubirFoto={props.onSubirFoto}
                  onSetPrincipal={props.onSetPrincipal}
                  onEliminarFoto={props.onEliminarFoto}
                />
              ))}
              {itemsActivos.length === 0 && (
                <tr>
                  <td colSpan={esBorrador ? 5 : 4} className="py-2 text-muted-foreground">
                    Sin artículos{esBorrador ? " — agrega productos desde tu catálogo" : ""}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {esBorrador && props.abierto && (
          <FormularioItem
            db={db}
            publicacion={pub}
            productos={props.productos}
            items={props.items}
          />
        )}

        {esBorrador && itemsInactivos.length > 0 && (
          <PapeleraItems db={db} items={itemsInactivos} productos={props.productos} />
        )}

        <div className="flex flex-wrap gap-2">
          {esBorrador && (
            <Button variant="outline" size="sm" onClick={props.onTogglePanel}>
              {props.abierto ? "Cerrar formulario" : "Agregar artículo"}
            </Button>
          )}
          <BotonPublicar
            puedePublicar={puedePublicar}
            online={props.online}
            pendiente={pendiente}
            esBorrador={esBorrador}
            publicando={props.publicando}
            onPublicar={props.onPublicar}
          />
          {(pub.estado === "borrador" || pub.estado === "publicado") && (
            <Button
              variant="outline"
              size="sm"
              disabled={!props.online || props.cancelando}
              title={!props.online ? "Requiere conexión" : undefined}
              onClick={props.onCancelar}
            >
              Cancelar
            </Button>
          )}
          {pub.estado === "publicado" && (
            <Button
              variant="outline"
              size="sm"
              disabled={!props.online || props.cerrando}
              title={!props.online ? "Requiere conexión" : undefined}
              onClick={props.onCerrar}
            >
              Cerrar
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Draft-only item form: LOCAL write (offline-capable), push confirms it later.
function FormularioItem({
  db,
  publicacion,
  productos,
  items,
}: Readonly<{
  db: RassaDatabase;
  publicacion: PublicacionDoc;
  productos: ProductoDoc[];
  items: ItemSemanalDoc[];
}>) {
  const activos = productos.filter((p) => p.estado);
  const yaAgregados = new Set(items.filter((i) => i.estado === "activo").map((i) => i.fkProducto));
  const disponibles = activos.filter((p) => !yaAgregados.has(p.id));

  const [fkProducto, setFkProducto] = useState("");
  const [precio, setPrecio] = useState("");
  const [stock, setStock] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const productoElegido = disponibles.find((p) => p.id === fkProducto);

  const enviar = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const precioNormalizado = normalizarPrecio(precio);
    const stockNum = Number.parseInt(stock, 10);
    if (
      !productoElegido ||
      precioNormalizado === null ||
      !Number.isInteger(stockNum) ||
      stockNum < 0
    ) {
      setError("Completa producto, precio (≥ 0) y stock (entero ≥ 0)");
      return;
    }
    if (!productoElegido.fkUnidad) {
      setError("El producto maestro no tiene unidad: elige una");
      return;
    }
    setError(null);
    setGuardando(true);
    const doc: ItemSemanalDoc = {
      id: crypto.randomUUID(),
      fkPublicacion: publicacion.id,
      fkProducto: productoElegido.id,
      fkUnidad: productoElegido.fkUnidad,
      precio: precioNormalizado,
      stock: stockNum,
      estado: "activo",
      version: 0,
      actualizadoEn: new Date().toISOString(),
      syncOpId: crypto.randomUUID(),
    };
    void db.itemsSemanales
      .insert(doc)
      .then(() => {
        toast.success("Artículo agregado al borrador (local)");
        setFkProducto("");
        setPrecio("");
        setStock("");
      })
      .catch(() => toast.error("No se pudo agregar el artículo localmente."))
      .finally(() => setGuardando(false));
  };

  return (
    <form onSubmit={enviar} className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">Nuevo artículo (borrador local)</p>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="item-producto">Producto maestro</Label>
          <select
            id="item-producto"
            value={fkProducto}
            onChange={(event) => setFkProducto(event.target.value)}
            className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
          >
            <option value="" disabled>
              Seleccione un producto…
            </option>
            {disponibles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="item-precio">Precio</Label>
          <Input
            id="item-precio"
            value={precio}
            onChange={(event) => setPrecio(event.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="item-stock">Stock</Label>
          <Input
            id="item-stock"
            value={stock}
            onChange={(event) => setStock(event.target.value)}
            placeholder="0"
            inputMode="numeric"
          />
        </div>
      </div>
      {error != null && <FormError>{error}</FormError>}
      <Button
        type="submit"
        disabled={guardando || disponibles.length === 0}
        title={
          disponibles.length === 0
            ? "Todos los productos activos ya están en la publicación"
            : undefined
        }
      >
        {guardando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : "Agregar artículo"}
      </Button>
    </form>
  );
}

// Draft items row: local edit (precio/stock) + quit/restaurar as estado changes, and
// the photo panel (online-only uploads).
function FilaItem(
  props: Readonly<{
    db: RassaDatabase;
    item: ItemSemanalDoc;
    productos: ProductoDoc[];
    imagenes: ImagenDoc[];
    esBorrador: boolean;
    online: boolean;
    subiendo: boolean;
    cambiandoPrincipal: boolean;
    eliminandoFoto: boolean;
    onSubirFoto: (fkItem: string, archivo: File) => void;
    onSetPrincipal: (imagen: ImagenDoc) => void;
    onEliminarFoto: (imagen: ImagenDoc) => void;
  }>,
) {
  const [editando, setEditando] = useState(false);
  const [precio, setPrecio] = useState(props.item.precio);
  const [stock, setStock] = useState(String(props.item.stock));
  const [panelAbierto, setPanelAbierto] = useState(false);

  const producto = props.productos.find((p) => p.id === props.item.fkProducto);
  const fotos = props.imagenes.filter((i) => i.fkProductoSemanal === props.item.id);
  const pendiente = props.item.syncOpId != null;

  const etiquetaFotos =
    fotos.length === 0 ? "sin fotos" : `${fotos.length} foto${fotos.length === 1 ? "" : "s"}`;

  const editarLocal = (cambios: Partial<ItemSemanalDoc>): void => {
    void props.db.itemsSemanales
      .findOne(props.item.id)
      .exec()
      .then((rxdoc) =>
        rxdoc?.incrementalPatch({
          ...cambios,
          actualizadoEn: new Date().toISOString(),
          syncOpId: crypto.randomUUID(),
        }),
      )
      .catch(() => toast.error("No se pudo editar localmente."));
  };

  return (
    <>
      <tr className="border-t">
        <td className="py-1.5 pr-3">
          {producto?.nombre ?? "Producto sin sincronizar"}
          {pendiente && <span className="ml-2 text-xs text-amber-500">pendiente</span>}
        </td>
        <td className="py-1.5 pr-3">
          {editando ? (
            <Input
              value={precio}
              onChange={(event) => setPrecio(event.target.value)}
              className="h-7 w-24"
              inputMode="decimal"
            />
          ) : (
            `$${props.item.precio}`
          )}
        </td>
        <td className="py-1.5 pr-3">
          {editando ? (
            <Input
              value={stock}
              onChange={(event) => setStock(event.target.value)}
              className="h-7 w-20"
              inputMode="numeric"
            />
          ) : (
            props.item.stock
          )}
        </td>
        <td className="py-1.5 pr-3">
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => setPanelAbierto(!panelAbierto)}
          >
            {etiquetaFotos}
          </button>
        </td>
        {props.esBorrador && (
          <td className="flex gap-1 py-1.5">
            {editando ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const precioNormalizado = normalizarPrecio(precio);
                    const stockNum = Number.parseInt(stock, 10);
                    if (precioNormalizado === null || !Number.isInteger(stockNum) || stockNum < 0) {
                      toast.error("Precio (≥ 0) o stock (entero ≥ 0) inválidos");
                      return;
                    }
                    editarLocal({ precio: precioNormalizado, stock: stockNum });
                    setEditando(false);
                  }}
                >
                  Guardar
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditando(false)}>
                  Cancelar
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setEditando(true)}>
                  Editar
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => editarLocal({ estado: "inactivo" })}
                >
                  Quitar
                </Button>
              </>
            )}
          </td>
        )}
      </tr>
      {panelAbierto && (
        <tr>
          <td colSpan={props.esBorrador ? 5 : 4} className="pb-3">
            <PanelFotos
              item={props.item}
              fotos={fotos}
              online={props.online}
              subiendo={props.subiendo}
              cambiandoPrincipal={props.cambiandoPrincipal}
              eliminando={props.eliminandoFoto}
              onSubir={props.onSubirFoto}
              onSetPrincipal={props.onSetPrincipal}
              onEliminar={props.onEliminarFoto}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function PanelFotos(
  props: Readonly<{
    item: ItemSemanalDoc;
    fotos: ImagenDoc[];
    online: boolean;
    subiendo: boolean;
    cambiandoPrincipal: boolean;
    eliminando: boolean;
    onSubir: (fkItem: string, archivo: File) => void;
    onSetPrincipal: (imagen: ImagenDoc) => void;
    onEliminar: (imagen: ImagenDoc) => void;
  }>,
) {
  const SERVER_URL = getServerUrl();
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Fotos del artículo (la subida de fotos requiere conexión).
        </p>
        <Label
          htmlFor={`foto-${props.item.id}`}
          className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent ${props.online ? "" : "pointer-events-none opacity-50"}`}
          title={!props.online ? "Requiere conexión" : undefined}
        >
          {props.subiendo ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          Subir foto
          <input
            id={`foto-${props.item.id}`}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={props.subiendo || !props.online}
            onChange={(event) => {
              const archivo = event.target.files?.[0];
              event.target.value = "";
              if (archivo) props.onSubir(props.item.id, archivo);
            }}
          />
        </Label>
      </div>
      {props.fotos.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sin fotos todavía.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {props.fotos.map((foto) => (
            <li key={foto.id} className="w-24 space-y-1 rounded-md border bg-background p-1.5">
              <ProductImage
                src={`${SERVER_URL}${foto.url}`}
                alt={`Foto de ${props.item.id}`}
                className="h-16 w-full rounded object-cover"
              />
              <p className="text-center text-[10px] text-muted-foreground">
                {foto.principal ? "Principal" : `#${foto.orden + 1}`}
              </p>
              {!foto.principal && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 w-full text-[10px]"
                  disabled={props.cambiandoPrincipal || !props.online}
                  onClick={() => props.onSetPrincipal(foto)}
                >
                  Principal
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-6 w-full text-[10px]"
                disabled={props.eliminando || !props.online}
                onClick={() => props.onEliminar(foto)}
              >
                Eliminar
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Soft-removed items of a draft (legacy papelera parity): restorable until publish.
function PapeleraItems(
  props: Readonly<{
    db: RassaDatabase;
    items: ItemSemanalDoc[];
    productos: ProductoDoc[];
  }>,
) {
  const restaurar = (item: ItemSemanalDoc): void => {
    void props.db.itemsSemanales
      .findOne(item.id)
      .exec()
      .then((rxdoc) =>
        rxdoc?.incrementalPatch({
          estado: "activo",
          actualizadoEn: new Date().toISOString(),
          syncOpId: crypto.randomUUID(),
        }),
      )
      .catch(() => toast.error("No se pudo restaurar localmente."));
  };
  return (
    <div>
      <h3 className="text-sm font-medium">Artículos retirados</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Quitar un artículo lo marca inactivo; puedes restaurarlo mientras el borrador siga abierto.
      </p>
      <ul className="space-y-1">
        {props.items.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-2 rounded-md border p-2"
          >
            <span className="text-sm text-muted-foreground">
              {props.productos.find((p) => p.id === item.fkProducto)?.nombre ?? item.fkProducto}
            </span>
            <span className="flex items-center gap-2">
              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                Inactivo
              </span>
              <Button variant="outline" size="sm" onClick={() => restaurar(item)}>
                Restaurar
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
