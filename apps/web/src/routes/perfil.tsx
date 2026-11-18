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
import { useEffect, useState, type FormEvent } from "react";
import type { MangoQuery } from "rxdb/plugins/core";
import { useRxQuery } from "rxdb/plugins/react";
import { toast } from "sonner";

import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, setSession, useSession } from "@/lib/auth/session";
import { type FamiliaDoc, type MembresiaDoc, type RassaDatabase } from "@/lib/rxdb/database";
import { startReplications } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { trpc } from "@/utils/trpc";

/**
 * P0 Usuarios — profile self-service (Q-05/Q-07): view own identity, edit OWN persona
 * fields only (email/rol are server-owned), change password. The family name comes from
 * the scoped RxDB collections filled by PULL (database.md §6.2 `usuarios`/`familias`).
 */
export const Route = createFileRoute("/perfil")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: PerfilRoute,
});

const FAMILIAS_QUERY: MangoQuery<FamiliaDoc> = { sort: [{ id: "asc" }] };
const MEMBRESIAS_QUERY: MangoQuery<MembresiaDoc> = { sort: [{ id: "asc" }] };

function PerfilRoute() {
  const session = useSession();
  const db = useDatabase();

  useEffect(() => {
    if (!db) return;
    const replications = startReplications(db);
    return () => {
      void replications.stop();
    };
  }, [db]);

  if (!db) {
    return (
      <div className="flex h-full items-center justify-center pt-8">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  return <PerfilPage db={db} marcado={session.user?.debeCambiarPassword ?? false} />;
}

function PerfilPage(props: Readonly<{ db: RassaDatabase; marcado: boolean }>) {
  const session = useSession();
  const consulta = useQuery(trpc.auth.me.queryOptions());

  if (consulta.isPending) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (!consulta.data) {
    return (
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Perfil</CardTitle>
            <CardDescription>No se pudo cargar tu perfil.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const yo = consulta.data;
  return (
    <div className="container mx-auto max-w-2xl space-y-6 px-4 py-4">
      <div>
        <h1 className="text-xl font-semibold">Mi perfil</h1>
        <p className="text-sm text-muted-foreground">
          Tus datos de identidad. El correo y el rol solo puede cambiarlos el administrador.
        </p>
      </div>

      {props.marcado && (
        <Card className="border-amber-500">
          <CardContent className="py-3 text-sm text-amber-600">
            Debe cambiar su contraseña: define una nueva para operar con normalidad.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Datos de la cuenta</CardTitle>
          <CardDescription>
            Estado: {yo.estado ? "Activo" : "Inactivo"} · Sesión: {session.user?.email}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            <span className="text-muted-foreground">Correo:</span> {yo.email}
          </p>
          <p>
            <span className="text-muted-foreground">Rol:</span>{" "}
            <span className="rounded-full border px-2 py-0.5 text-xs">{yo.rol}</span>
          </p>
          <FamiliaPropia db={props.db} />
        </CardContent>
      </Card>

      <FormularioPerfil yo={yo} />
      <FormularioPassword />
    </div>
  );
}

function FamiliaPropia({ db }: Readonly<{ db: RassaDatabase }>) {
  const session = useSession();
  const idUsuario = session.user?.id ?? "";
  const familias = useRxQuery<FamiliaDoc>({ collection: db.familias, query: FAMILIAS_QUERY });
  const membresias = useRxQuery<MembresiaDoc>({
    collection: db.membresias,
    query: MEMBRESIAS_QUERY,
  });

  const docsMembresias = membresias.results.map((doc) => doc.toJSON() as MembresiaDoc);
  const membresiaPropia = docsMembresias.find((m) => m.fkUsuario === idUsuario && m.estado);
  const familia = membresiaPropia
    ? familias.results
        .map((doc) => doc.toJSON() as FamiliaDoc)
        .find((f) => f.id === membresiaPropia.fkFamilia)
    : undefined;

  return (
    <p>
      <span className="text-muted-foreground">Familia:</span>{" "}
      {familia?.nombre ?? "Sin familia asignada"}
    </p>
  );
}

type PerfilYo = {
  email: string;
  rol: string;
  estado: boolean;
  persona: {
    nombre: string;
    apellidoPaterno: string;
    apellidoMaterno: string | null;
    fkLocalidad: string | null;
  };
};

function FormularioPerfil(props: Readonly<{ yo: PerfilYo }>) {
  const queryClient = useQueryClient();
  const { yo } = props;
  const [nombre, setNombre] = useState(yo.persona.nombre);
  const [apellidoPaterno, setApellidoPaterno] = useState(yo.persona.apellidoPaterno);
  const [apellidoMaterno, setApellidoMaterno] = useState(yo.persona.apellidoMaterno ?? "");
  const [fkLocalidad, setFkLocalidad] = useState(yo.persona.fkLocalidad ?? "");

  // Localidad picker: same public read-only source as /registro (the current value may
  // not be in the visible list if the row was deactivated — the select keeps it).
  const localidades = useQuery(trpc.catalogos.localidadesPublicas.queryOptions());

  const guardar = useMutation(
    trpc.usuarios.updatePerfil.mutationOptions({
      onSuccess: () => {
        toast.success("Perfil actualizado");
        void queryClient.invalidateQueries();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const enviar = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    guardar.mutate({
      nombre: nombre.trim(),
      apellidoPaterno: apellidoPaterno.trim(),
      apellidoMaterno: apellidoMaterno.trim(),
      ...(fkLocalidad ? { fkLocalidad } : {}),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Editar datos personales</CardTitle>
        <CardDescription>Solo puedes editar tus propios datos personales.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={enviar} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="perfil-nombre">Nombre</Label>
              <Input
                id="perfil-nombre"
                value={nombre}
                onChange={(event) => setNombre(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perfil-ap">Apellido paterno</Label>
              <Input
                id="perfil-ap"
                value={apellidoPaterno}
                onChange={(event) => setApellidoPaterno(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perfil-am">Apellido materno</Label>
              <Input
                id="perfil-am"
                value={apellidoMaterno}
                onChange={(event) => setApellidoMaterno(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5 max-w-xs">
            <Label htmlFor="perfil-localidad">Localidad</Label>
            <select
              id="perfil-localidad"
              value={fkLocalidad}
              onChange={(event) => setFkLocalidad(event.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              <option value="">Sin localidad</option>
              {(localidades.data ?? []).map((localidad) => (
                <option key={localidad.id} value={localidad.id}>
                  {localidad.nombre} ({localidad.municipio})
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={guardar.isPending}>
            {guardar.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              "Guardar cambios"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function FormularioPassword() {
  const session = useSession();
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");

  const cambiar = useMutation(
    trpc.auth.changePassword.mutationOptions({
      onSuccess: () => {
        setActual("");
        setNueva("");
        // The server revoked every refresh session (defensive default); this tab keeps
        // its access token until expiry, then requires a fresh login.
        if (session.user && getAccessToken()) {
          setSession({ ...session.user, debeCambiarPassword: false }, getAccessToken()!);
        }
        toast.success("Contraseña actualizada");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const enviar = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!actual || !nueva) {
      toast.error("Completa la contraseña actual y la nueva.");
      return;
    }
    cambiar.mutate({ currentPassword: actual, newPassword: nueva });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cambiar contraseña</CardTitle>
        <CardDescription>
          Al cambiarla se cierran las sesiones activas en otros dispositivos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={enviar} className="space-y-3 max-w-xs">
          <div className="space-y-1.5">
            <Label htmlFor="perfil-pass-actual">Contraseña actual</Label>
            <Input
              id="perfil-pass-actual"
              type="password"
              autoComplete="current-password"
              value={actual}
              onChange={(event) => setActual(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="perfil-pass-nueva">Nueva contraseña</Label>
            <Input
              id="perfil-pass-nueva"
              type="password"
              autoComplete="new-password"
              value={nueva}
              onChange={(event) => setNueva(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={cambiar.isPending}>
            {cambiar.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              "Actualizar contraseña"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
