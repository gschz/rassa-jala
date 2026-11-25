import { Badge } from "@rassa-jala/ui/components/badge";
import { Button } from "@rassa-jala/ui/components/button";
import { Card, CardContent } from "@rassa-jala/ui/components/card";
import { Input } from "@rassa-jala/ui/components/input";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2, Minus, Plus, ShoppingCart, Trash2, User } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MangoQuery } from "rxdb/plugins/core";
import { useRxQueryLive } from "@/lib/rxdb/use-live-query";
import { toast } from "sonner";

import { getServerUrl } from "@/lib/server-url";
import {
  agregarAlCarrito,
  cambiarCantidad,
  estimadoDe,
  lineasDelCarrito,
  vaciarCarrito,
} from "@/lib/cart";
import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { ProductImage } from "@/components/product-image";
import { BotonContactar } from "@/components/boton-contactar";
import {
  type CategoriaDoc,
  type CarritoDoc,
  type ImagenDoc,
  type ItemSemanalDoc,
  type PedidoDoc,
  type ProductoDoc,
  type PublicacionDoc,
  type RassaDatabase,
} from "@/lib/rxdb/database";
import { startReplications, type ReplicationSet } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { trpc } from "@/utils/trpc";
import { useOnline } from "@/hooks/use-online";
import { aFechaCiclo, mondayOfBusinessWeek } from "@rassa-jala/db/iso-semana";
import { PageContainer } from "@/components/page-header";
import { notificarError } from "@/lib/notificar-error";

/**
 * P0 Catálogo semanal — buyer view of the CURRENT ciclo's published offers
 * (docs/scope.md §3.1 Publicaciones + Pedidos; scoping database.md §6.2: comprador →
 * `publicado` de la semana activa). Offline-first: reads the replicated RxDB
 * collections (itemsSemanales + productos + imagenes + categorias + publicaciones),
 * so it keeps working without connection for previously synced data.
 *
 * Cart (P0 Pedidos): a LOCAL RxDB collection (no replication); checkout ONLINE goes
 * through the tRPC adjudication; OFFLINE it queues a local order draft that the pedidos
 * push adjudicates on reconnect. The client totals are display-only ("estimado") —
 * the server snapshot is the only authority (Q-14).
 */

export const Route = createFileRoute("/catalogo")({
  // Protected route (same contract as /): token or one silent refresh.
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: CatalogoRoute,
});

// RxDB Mango sort is lexical over the string price ("5.00" > "33.33"); the display
// order is numeric (display-only — the money authority stays the DTO string).
const ITEMS_QUERY: MangoQuery<ItemSemanalDoc> = { sort: [{ precio: "asc" }] };
const porPrecioNumerico = (a: ItemSemanalDoc, b: ItemSemanalDoc): number =>
  Number(a.precio) - Number(b.precio);
const PRODUCTOS_QUERY: MangoQuery<ProductoDoc> = { sort: [{ nombre: "asc" }] };
const IMAGENES_QUERY: MangoQuery<ImagenDoc> = { sort: [{ orden: "asc" }] };
const CATEGORIAS_QUERY: MangoQuery<CategoriaDoc> = { sort: [{ nombre: "asc" }] };
const PUBLICACIONES_QUERY: MangoQuery<PublicacionDoc> = { sort: [{ fechaCiclo: "desc" }] };
const CARRITO_QUERY: MangoQuery<CarritoDoc> = { sort: [{ agregadoEn: "asc" }] };

function CatalogoRoute() {
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
  return <PaginaCatalogo db={db} resincronizar={resincronizar} />;
}

function PaginaCatalogo({
  db,
  resincronizar,
}: Readonly<{ db: RassaDatabase; resincronizar: () => void }>) {
  const session = useSession();
  const enLinea = useOnline();
  const itemsQuery = useRxQueryLive<ItemSemanalDoc>({
    collection: db.itemsSemanales,
    query: ITEMS_QUERY,
  });
  const items = useMemo(
    () => itemsQuery.results.map((d) => d.toJSON() as ItemSemanalDoc).sort(porPrecioNumerico),
    [itemsQuery.results],
  );
  const productos = useRxQueryLive<ProductoDoc>({
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
  const publicaciones = useRxQueryLive<PublicacionDoc>({
    collection: db.publicaciones,
    query: PUBLICACIONES_QUERY,
  });
  const unidades = useQuery(trpc.catalogos.unidadesList.queryOptions({}));
  const carrito = useRxQueryLive<CarritoDoc>({
    collection: db.carrito,
    query: CARRITO_QUERY,
  });

  const [busqueda, setBusqueda] = useState("");
  const [categoria, setCategoria] = useState("");
  const [cantidades, setCantidades] = useState<Record<string, number>>({});

  // The buyer scope is enforced server-side (pull delivers ONLY published current-ciclo
  // docs to buyers); the client-side filter keeps the view uniform for every role
  // (an agricultor/admin browsing /catalogo sees the same rule applied).
  const cicloActual = aFechaCiclo(mondayOfBusinessWeek(new Date()));
  const idsPublicadas = new Set(
    publicaciones.results
      .map((doc) => doc.toJSON() as PublicacionDoc)
      .filter((p) => p.estado === "publicado" && p.fechaCiclo === cicloActual)
      .map((p) => p.id),
  );

  const docsProductos = productos.results.map((doc) => doc.toJSON() as ProductoDoc);
  const productoPorId = new Map(docsProductos.map((p) => [p.id, p] as const));
  // T17: the publication doc carries the farmer's user id (the item doc only embeds
  // the NAME — G2) — "Contactar" opens the 1:1 chat with it.
  const publicacionPorId = new Map(
    publicaciones.results
      .map((doc) => doc.toJSON() as PublicacionDoc)
      .map((p) => [p.id, p] as const),
  );
  const docsUnidades = unidades.data ?? [];
  const abrevPorUnidad = new Map(
    docsUnidades.map((u) => [u.id, u.abreviatura ?? u.nombre ?? ""] as const),
  );
  const docsCategorias = categorias.results.map((doc) => doc.toJSON() as CategoriaDoc);
  const nombreCategoria = new Map(docsCategorias.map((c) => [c.id, c.nombre] as const));

  // Thumbnail: the item's principal weekly photo; fallback to the maestro product's.
  const fotoDe = (item: ItemSemanalDoc): ImagenDoc | undefined => {
    const deItem = imagenes.results
      .map((doc) => doc.toJSON() as ImagenDoc)
      .find((i) => i.fkProductoSemanal === item.id && i.principal);
    if (deItem) return deItem;
    return imagenes.results
      .map((doc) => doc.toJSON() as ImagenDoc)
      .find((i) => i.fkProducto === item.fkProducto && i.principal);
  };

  const busquedaNormalizada = busqueda.trim().toLowerCase();
  const ofertas = items.filter(
    (item) =>
      item.estado === "activo" &&
      idsPublicadas.has(item.fkPublicacion) &&
      (!categoria || productoPorId.get(item.fkProducto)?.fkCategoria === categoria) &&
      (!busquedaNormalizada ||
        (productoPorId.get(item.fkProducto)?.nombre ?? "")
          .toLowerCase()
          .includes(busquedaNormalizada)),
  );

  // ---- Cart (P0 Pedidos): display-only estimates + checkout (online/offline) ----
  const lineas = lineasDelCarrito(carrito.results.map((doc) => doc.toJSON() as CarritoDoc));
  const estimado = estimadoDe(lineas);

  const checkout = useMutation(
    trpc.pedidos.checkout.mutationOptions({
      onSuccess: async () => {
        toast.success("Pedido creado — queda pendiente de confirmación");
        await vaciarCarrito(db);
        resincronizar();
      },
      onError: (error) => notificarError(error),
    }),
  );

  // Offline checkout: queue a LOCAL order draft; the pedidos push adjudicates it on
  // reconnect. Never shown as confirmed while syncOpId is present (scope.md §6).
  const checkoutOffline = async (): Promise<void> => {
    const doc: PedidoDoc = {
      id: crypto.randomUUID(),
      fkCliente: session.user?.id ?? null,
      fkVendedor: null,
      estadoNombre: "pendiente",
      estado: true,
      subtotal: estimado.subtotal,
      iva: estimado.iva,
      total: estimado.total,
      origen: "digital",
      clienteNombre: null,
      clienteTelefono: null,
      notas: null,
      version: 0,
      actualizadoEn: new Date().toISOString(),
      items: lineas.map((l) => ({ fkProductoSemanal: l.fkProductoSemanal, cantidad: l.cantidad })),
      syncOpId: crypto.randomUUID(),
    };
    await db.pedidos.insert(doc);
    await vaciarCarrito(db);
    toast.info("Sin conexión: pedido en cola — Pendiente de confirmación");
  };

  const SERVER_URL = getServerUrl();

  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Catálogo</h1>
        <p className="text-sm text-muted-foreground">
          Ofertas publicadas para el ciclo del {cicloActual}. Agrega al carrito y haz tu pedido:
          online se confirma al instante, sin conexión queda en cola hasta sincronizar.
        </p>
      </div>

      {lineas.length > 0 && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-2">
              <ShoppingCart className="h-4 w-4" />
              <p className="font-medium">Tu carrito</p>
            </div>
            <div className="space-y-2">
              {lineas.map((linea) => (
                <div key={linea.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex-1 truncate">{linea.nombre}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="Quitar uno"
                      onClick={() =>
                        void cambiarCantidad(db, linea.fkProductoSemanal, linea.cantidad - 1)
                      }
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <span className="w-8 text-center">{linea.cantidad}</span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="Agregar uno"
                      disabled={linea.cantidad >= linea.stock}
                      onClick={() =>
                        void cambiarCantidad(db, linea.fkProductoSemanal, linea.cantidad + 1)
                      }
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="Quitar del carrito"
                      onClick={() => void cambiarCantidad(db, linea.fkProductoSemanal, 0)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t pt-2 text-sm">
              <p className="text-muted-foreground">
                Subtotal estimado ${estimado.subtotal} + IVA ${estimado.iva} (estimado en pantalla;
                el servidor calcula los montos oficiales)
              </p>
              <p className="text-lg font-semibold">Total estimado: ${estimado.total}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                disabled={checkout.isPending}
                onClick={() => {
                  if (enLinea) {
                    checkout.mutate({
                      items: lineas.map((l) => ({
                        fkProductoSemanal: l.fkProductoSemanal,
                        cantidad: l.cantidad,
                      })),
                    });
                  } else {
                    void checkoutOffline();
                  }
                }}
              >
                {checkout.isPending ? "Enviando…" : enLinea ? "Hacer pedido" : "Pedir sin conexión"}
              </Button>
              <Button variant="outline" onClick={() => void vaciarCarrito(db)}>
                Vaciar
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {enLinea
                ? "El servidor valida stock, crédito y montos; el pedido queda 'Pendiente' hasta su confirmación."
                : "Sin conexión: el pedido se guarda localmente y se envía al reconectar."}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={busqueda}
          onChange={(event) => setBusqueda(event.target.value)}
          placeholder="Buscar producto…"
          className="w-64"
        />
        <select
          value={categoria}
          onChange={(event) => setCategoria(event.target.value)}
          className="flex h-10 rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
          aria-label="Filtrar por categoría"
        >
          <option value="">Todas las categorías</option>
          {docsCategorias
            .filter((c) => c.estado)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
        </select>
        {ofertas.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setBusqueda("");
              setCategoria("");
            }}
          >
            Limpiar
          </Button>
        )}
      </div>

      {ofertas.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Sin ofertas publicadas para esta semana todavía.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ofertas.map((item) => {
            const producto = productoPorId.get(item.fkProducto);
            const foto = fotoDe(item);
            const agotado = item.stock <= 0;
            const fkAgricultor = publicacionPorId.get(item.fkPublicacion)?.fkAgricultor ?? null;
            const puedeContactar = fkAgricultor !== null && fkAgricultor !== session.user?.id;
            return (
              <Card key={item.id}>
                <CardContent className="flex flex-col gap-3 p-4">
                  <ProductImage
                    src={foto ? `${SERVER_URL}${foto.url}` : null}
                    alt={`Imagen de ${producto?.nombre ?? item.fkProducto}`}
                    className="aspect-square w-full rounded-md object-cover"
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="truncate font-semibold leading-tight">
                      {producto?.nombre ?? "Producto sin sincronizar"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {nombreCategoria.get(producto?.fkCategoria ?? "") ?? "—"}
                      {abrevPorUnidad.get(item.fkUnidad)
                        ? ` · por ${abrevPorUnidad.get(item.fkUnidad)}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    {/* Money is the DTO string as-is — the client never computes totals. */}
                    <p className="text-2xl font-semibold tracking-tight">${item.precio}</p>
                    {/* Stock badge only when it matters: low stock → amber, none → destructive;
                        healthy stock stays badge-free. */}
                    {item.stock <= 5 && (
                      <Badge variant={agotado ? "destructive" : "warning"}>
                        {agotado ? "Agotado" : `Quedan ${item.stock}`}
                      </Badge>
                    )}
                  </div>
                  {/* G2: farmer name embedded in the synced item doc — renders offline. */}
                  {(item.agricultorNombre || puedeContactar) && (
                    <div className="flex items-center justify-between gap-2">
                      {item.agricultorNombre && (
                        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <User className="size-3.5 shrink-0" aria-hidden />
                          <span className="truncate">{item.agricultorNombre}</span>
                        </p>
                      )}
                      {/* T17: "Contactar" opens a 1:1 chat with the product's farmer
                          (get-or-create, idempotent) — never for one's own rows. */}
                      {fkAgricultor && fkAgricultor !== session.user?.id && (
                        <div className="ml-auto">
                          <BotonContactar fkUsuario={fkAgricultor} />
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="Reducir cantidad"
                        disabled={(cantidades[item.id] ?? 1) <= 1}
                        onClick={() =>
                          setCantidades((prev) => ({
                            ...prev,
                            [item.id]: Math.max(1, (prev[item.id] ?? 1) - 1),
                          }))
                        }
                      >
                        <Minus />
                      </Button>
                      <Input
                        type="number"
                        min={1}
                        max={item.stock}
                        value={cantidades[item.id] ?? 1}
                        onChange={(event) =>
                          setCantidades((prev) => ({
                            ...prev,
                            [item.id]: Math.max(1, Number(event.target.value) || 1),
                          }))
                        }
                        className="h-8 w-12 [appearance:textfield] text-center"
                        aria-label={`Cantidad de ${producto?.nombre ?? "producto"}`}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="Aumentar cantidad"
                        disabled={(cantidades[item.id] ?? 1) >= item.stock}
                        onClick={() =>
                          setCantidades((prev) => ({
                            ...prev,
                            [item.id]: (prev[item.id] ?? 1) + 1,
                          }))
                        }
                      >
                        <Plus />
                      </Button>
                    </div>
                    <Button
                      className="flex-1"
                      disabled={item.stock <= 0}
                      onClick={() =>
                        void agregarAlCarrito(
                          db,
                          item,
                          producto?.nombre ?? item.fkProducto,
                          cantidades[item.id] ?? 1,
                        )
                      }
                    >
                      Agregar
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
