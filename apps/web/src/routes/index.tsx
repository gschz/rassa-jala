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
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState, type SubmitEvent } from "react";
import type { MangoQuery } from "rxdb/plugins/core";
import { useRxQuery } from "rxdb/plugins/react";
import { toast } from "sonner";

import Loader from "@/components/loader";
import { EstadoSincronizacion } from "@/components/sync/sync-status-bar";
import { useOnline } from "@/hooks/use-online";
import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import {
  type FamiliaDoc,
  type LocalidadDoc,
  type MembresiaDoc,
  type MunicipioDoc,
  type RassaDatabase,
} from "@/lib/rxdb/database";
import { startReplications } from "@/lib/rxdb/replication";
import { trackPending, useSyncStatus } from "@/lib/rxdb/sync-status";
import { useDatabase } from "@/lib/rxdb/use-database";

/**
 * Vertical slice — offline catalog page (RxDB + PULL/PUSH replication).
 *
 * Manual offline test recipe (scope.md §7.1 points 4–9):
 * 1. With the server running, load this page online: the four collections
 *    fill via sync.pull checkpoints (municipios, localidades, categorias,
 *    unidades) and the per-collection chips show the last sync.
 * 2. DevTools -> Network -> Offline. Create a localidad: it renders instantly
 *    from the local RxDB write, marked "Pendiente de sincronizar" (never as
 *    confirmed).
 * 3. Reload while still offline: the localidad is still listed (IndexedDB
 *    persistence via Dexie) and still marked pending.
 * 4. Back online: the replication pushes the pending write (sync.push ->
 *    aplicada) and the badge turns to "Sincronizado" once the server state
 *    round-trips through PULL; the row now exists in PostgreSQL.
 */

export const Route = createFileRoute("/")({
  // Protected route (P0 auth): without an in-memory access token, try one silent refresh
  // (the httpOnly cookie may still be valid after a reload); otherwise → /login.
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: HomeComponent,
});

// Stable query objects: a new object identity every render would make the
// live-query hooks resubscribe on every render.
const SORT_NOMBRE: MangoQuery<MunicipioDoc> = { sort: [{ nombre: "asc" }] };
const LOCALIDADES_QUERY: MangoQuery<LocalidadDoc> = {
  sort: [{ nombre: "asc" }],
};
// Own-family display: read the full scoped collections and filter by identity
// client-side (the server already scopes what each user receives via PULL).
const FAMILIAS_QUERY: MangoQuery<FamiliaDoc> = { sort: [{ id: "asc" }] };
const MEMBRESIAS_QUERY: MangoQuery<MembresiaDoc> = { sort: [{ id: "asc" }] };

function HomeComponent() {
  const db = useDatabase();

  useEffect(() => {
    if (!db) return;
    const replications = startReplications(db);
    return () => {
      void replications.stop();
    };
  }, [db]);

  if (!db) return <Loader />;
  return <CatalogoPage db={db} />;
}

function CatalogoPage({ db }: Readonly<{ db: RassaDatabase }>) {
  const status = useSyncStatus();
  const online = useOnline();

  const municipios = useRxQuery<MunicipioDoc>({
    collection: db.municipios,
    query: SORT_NOMBRE,
  });
  const localidades = useRxQuery<LocalidadDoc>({
    collection: db.localidades,
    query: LOCALIDADES_QUERY,
  });

  return (
    <div className="container mx-auto max-w-4xl space-y-4 px-4 py-4">
      <div>
        <h1 className="text-xl font-semibold">Catálogos</h1>
        <p className="text-sm text-muted-foreground">
          Corte vertical — lectura offline (PULL) y escritura de localidades (PUSH).
        </p>
      </div>

      <EstadoSincronizacion online={online} status={status} />

      <TarjetaMiFamilia db={db} />

      <div className="grid gap-4 md:grid-cols-2">
        <NuevaLocalidadForm
          db={db}
          municipios={municipios.results.map((doc) => doc.toJSON() as MunicipioDoc)}
        />
        <ListaLocalidades
          localidades={localidades.results.map((doc) => doc.toJSON() as LocalidadDoc)}
          municipios={municipios.results.map((doc) => doc.toJSON() as MunicipioDoc)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Municipios</CardTitle>
          <CardDescription>
            {municipios.results.length === 0
              ? "Sin municipios sincronizados aún."
              : `${municipios.results.length} sincronizados desde el servidor.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {municipios.results.map((doc) => {
            const municipio = doc.toJSON() as MunicipioDoc;
            return (
              <span
                key={municipio.id}
                className="rounded-full border px-3 py-1 text-sm text-muted-foreground"
              >
                {municipio.nombre}
              </span>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function TarjetaMiFamilia({ db }: Readonly<{ db: RassaDatabase }>) {
  const session = useSession();
  const idUsuario = session.user?.id ?? "";
  const familias = useRxQuery<FamiliaDoc>({ collection: db.familias, query: FAMILIAS_QUERY });
  const membresias = useRxQuery<MembresiaDoc>({
    collection: db.membresias,
    query: MEMBRESIAS_QUERY,
  });

  const docsFamilias = familias.results.map((doc) => doc.toJSON() as FamiliaDoc);
  const docsMembresias = membresias.results.map((doc) => doc.toJSON() as MembresiaDoc);
  const membresiaPropia = docsMembresias.find((m) => m.fkUsuario === idUsuario && m.estado);
  const familia = membresiaPropia
    ? docsFamilias.find((f) => f.id === membresiaPropia.fkFamilia)
    : undefined;
  const integrantes = familia ? docsMembresias.filter((m) => m.fkFamilia === familia.id) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mi familia</CardTitle>
        <CardDescription>
          Datos entregados por replicación PULL según tu identidad: un usuario solo recibe su propia
          familia.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!familia ? (
          <p className="text-sm text-muted-foreground">Sin familia asignada</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">{familia.nombre}</p>
            <ul className="space-y-1">
              {integrantes.map((miembro) => (
                <li
                  key={miembro.id}
                  className="flex items-center justify-between gap-2 rounded-md border p-2"
                >
                  <span className="text-sm">{miembro.correo}</span>
                  {miembro.fkUsuario === familia.fkJefeUsuario && (
                    <span className="rounded-full border px-2 py-0.5 text-xs text-amber-600">
                      Jefe
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NuevaLocalidadForm({
  db,
  municipios,
}: Readonly<{
  db: RassaDatabase;
  municipios: MunicipioDoc[];
}>) {
  const [nombre, setNombre] = useState("");
  const [fkMunicipio, setFkMunicipio] = useState("");
  const [guardando, setGuardando] = useState(false);

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nombreTrimmed = nombre.trim();
    if (!nombreTrimmed || !fkMunicipio || guardando) return;
    setGuardando(true);
    const doc: LocalidadDoc = {
      id: crypto.randomUUID(),
      nombre: nombreTrimmed,
      fkMunicipio,
      estado: true,
      version: 0,
      actualizadoEn: new Date().toISOString(),
      // Idempotency key assigned once by the local write path (sync doc §7).
      syncOpId: crypto.randomUUID(),
    };
    void db.localidades
      .insert(doc)
      .then(() => {
        trackPending(doc.id);
        setNombre("");
        setFkMunicipio("");
      })
      .catch(() => toast.error("No se pudo crear la localidad localmente."))
      .finally(() => setGuardando(false));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nueva localidad</CardTitle>
        <CardDescription>
          Se guarda localmente y se envía al servidor al reconectar.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="localidad-nombre">Nombre</Label>
            <Input
              id="localidad-nombre"
              value={nombre}
              onChange={(event) => setNombre(event.target.value)}
              placeholder="Nombre de la localidad"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="localidad-municipio">Municipio</Label>
            <select
              id="localidad-municipio"
              value={fkMunicipio}
              onChange={(event) => setFkMunicipio(event.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              <option value="" disabled>
                Seleccione un municipio…
              </option>
              {municipios.map((municipio) => (
                <option key={municipio.id} value={municipio.id}>
                  {municipio.nombre}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="submit"
            disabled={!nombre.trim() || !fkMunicipio || guardando}
            className="w-full"
          >
            {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : "Crear localidad"}
          </Button>
          {municipios.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Los municipios se obtienen del servidor al sincronizar.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function ListaLocalidades({
  localidades,
  municipios,
}: Readonly<{
  localidades: LocalidadDoc[];
  municipios: MunicipioDoc[];
}>) {
  const status = useSyncStatus();
  const pendingIds = new Set(status.pendingLocalidadIds);
  const municipioById = new Map(municipios.map((m) => [m.id, m]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Localidades</CardTitle>
        <CardDescription>
          {localidades.length === 0
            ? "Sin localidades sincronizadas aún."
            : `${localidades.length} registradas.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {localidades.map((localidad) => {
            // A doc still carrying its idempotency key has not been
            // confirmed by the server yet (its state round-trips only after
            // the push verdict), so it can never show as confirmed.
            const pendiente = pendingIds.has(localidad.id) || localidad.syncOpId != null;
            return (
              <li
                key={localidad.id}
                className="flex items-center justify-between gap-2 rounded-md border p-2"
              >
                <div>
                  <p className="text-sm font-medium">{localidad.nombre}</p>
                  <p className="text-xs text-muted-foreground">
                    {municipioById.get(localidad.fkMunicipio)?.nombre ??
                      "Municipio sin sincronizar"}
                  </p>
                </div>
                <span
                  className={`text-xs font-medium ${pendiente ? "text-amber-500" : "text-emerald-500"}`}
                >
                  {pendiente ? "Pendiente de sincronizar" : "Sincronizado"}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
