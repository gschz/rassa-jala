import { Alert, AlertDescription } from "@rassa-jala/ui/components/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@rassa-jala/ui/components/avatar";
import { Badge } from "@rassa-jala/ui/components/badge";
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
import { PasswordInput } from "@rassa-jala/ui/components/password-input";
import { Separator } from "@rassa-jala/ui/components/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rassa-jala/ui/components/select";
import { Textarea } from "@rassa-jala/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import type { MangoQuery } from "rxdb/plugins/core";
import { toast } from "sonner";

import { FormError } from "@/components/form-error";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { authFetch, refreshSession } from "@/lib/auth/http";
import { getAccessToken, setSession, useSession } from "@/lib/auth/session";
import { type FamiliaDoc, type MembresiaDoc, type RassaDatabase } from "@/lib/rxdb/database";
import { startReplications } from "@/lib/rxdb/replication";
import { useDatabase } from "@/lib/rxdb/use-database";
import { useRxQueryLive } from "@/lib/rxdb/use-live-query";
import { getServerUrl } from "@/lib/server-url";
import { PageContainer } from "@/components/page-header";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/**
 * P0 Usuarios — profile self-service (Q-05/Q-07): view own identity, edit OWN persona
 * fields only (email/rol are server-owned), change password, manage the profile photo
 * (gap-pass-8). The family name comes from the scoped RxDB collections filled by PULL
 * (database.md §6.2 `usuarios`/`familias`).
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
      <PageContainer>
        <Card>
          <CardHeader>
            <CardTitle>Perfil</CardTitle>
            <CardDescription>No se pudo cargar tu perfil.</CardDescription>
          </CardHeader>
        </Card>
      </PageContainer>
    );
  }

  const yo = consulta.data;
  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Mi perfil</h1>
        <p className="text-sm text-muted-foreground">
          Tus datos de identidad. El correo y el rol solo puede cambiarlos el administrador.
        </p>
      </div>

      {props.marcado && (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Debe cambiar su contraseña: define una nueva para operar con normalidad.
          </AlertDescription>
        </Alert>
      )}

      <EncabezadoIdentidad db={props.db} yo={yo} />
      <FormularioPerfil yo={yo} />
      <FormularioPassword />
    </PageContainer>
  );
}

type LocalidadActual = {
  id: string;
  nombre: string;
  municipio: string;
  estado: boolean;
};

type PerfilYo = {
  email: string;
  rol: string;
  estado: boolean;
  persona: {
    nombre: string;
    apellidoPaterno: string;
    apellidoMaterno: string | null;
    fkLocalidad: string | null;
    telefono: string | null;
    // tRPC serializes the Prisma Date to an ISO string over httpBatchLink.
    fechaNacimiento: string | Date | null;
    sexo: string | null;
    domicilio: string | null;
    fotoUrl: string | null;
    localidad: LocalidadActual | null;
  };
};

// ---- identity header (gap-pass-8): ONE card summarizing who you are ----

function EncabezadoIdentidad(props: Readonly<{ db: RassaDatabase; yo: PerfilYo }>) {
  const { yo } = props;
  const nombreCompleto =
    [yo.persona.nombre, yo.persona.apellidoPaterno, yo.persona.apellidoMaterno]
      .filter((parte) => parte)
      .join(" ") || "Sin nombre";
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <SeccionAvatar yo={yo} />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate text-lg font-semibold">{nombreCompleto}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{yo.rol}</Badge>
            {yo.estado ? (
              <Badge variant="success">Activo</Badge>
            ) : (
              <Badge variant="destructive">Inactivo</Badge>
            )}
          </div>
          <p className="truncate text-sm text-muted-foreground">{yo.email}</p>
          <FamiliaPropia db={props.db} />
        </div>
      </CardContent>
    </Card>
  );
}

// Profile photo (gap-pass-8): circular avatar with the design-system initials
// fallback; the multipart bridge POST /upload/perfil carries the bytes and
// usuarios.quitarFoto clears the reference. The Avatar fallback also covers a
// broken image (Base UI swaps it in when the load fails).
function SeccionAvatar({ yo }: Readonly<{ yo: PerfilYo }>) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmarQuitar, setConfirmarQuitar] = useState(false);

  const subir = useMutation({
    mutationFn: subirFotoPerfil,
    onSuccess: () => {
      toast.success("Foto actualizada");
      void queryClient.invalidateQueries();
    },
    onError: (error) => notificarError(error),
  });
  const quitar = useMutation(
    trpc.usuarios.quitarFoto.mutationOptions({
      onSuccess: () => {
        toast.success("Foto eliminada");
        void queryClient.invalidateQueries();
      },
      onError: (error) => notificarError(error),
    }),
  );

  const elegirArchivo = (archivo: File | undefined): void => {
    if (!archivo) return;
    // Client-side mirrors of the server's upload contract (the trust boundary
    // is server-side — these just surface the error earlier).
    if (!FOTOS_MIME.has(archivo.type)) {
      toast.error("Formato no permitido: usa PNG, JPG o WebP");
      return;
    }
    if (archivo.size > FOTO_MAX_BYTES) {
      toast.error("La imagen supera el tamaño máximo de 5 MiB");
      return;
    }
    subir.mutate(archivo);
  };

  const fotoSrc = yo.persona.fotoUrl ? `${getServerUrl()}${yo.persona.fotoUrl}` : null;
  return (
    <div className="flex items-center gap-4">
      <Avatar className="size-20">
        {fotoSrc && <AvatarImage src={fotoSrc} alt="Foto de perfil" />}
        <AvatarFallback className="bg-primary text-primary-foreground text-xl">
          {iniciales(yo.persona.nombre, yo.persona.apellidoPaterno)}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={subir.isPending || quitar.isPending}
          onClick={() => inputRef.current?.click()}
        >
          {subir.isPending ? (
            <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden />
          ) : yo.persona.fotoUrl ? (
            "Cambiar foto"
          ) : (
            "Subir foto"
          )}
        </Button>
        {yo.persona.fotoUrl && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={quitar.isPending}
            onClick={() => setConfirmarQuitar(true)}
          >
            Quitar
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const archivo = event.target.files?.[0];
          // Reset so re-picking the same file fires onChange again.
          event.target.value = "";
          elegirArchivo(archivo);
        }}
      />
      <ConfirmDialog
        open={confirmarQuitar}
        onOpenChange={setConfirmarQuitar}
        title="Quitar foto de perfil"
        description="Se eliminará tu foto actual. Puedes subir una nueva cuando quieras."
        confirmLabel="Quitar"
        destructive
        onConfirm={() => quitar.mutate()}
      />
    </div>
  );
}

function iniciales(nombre: string, apellidoPaterno: string): string {
  const par = `${nombre.charAt(0)}${apellidoPaterno.charAt(0)}`.trim();
  return par === "" ? "?" : par.toUpperCase();
}

/** Client-side mirrors of the server's upload contract (trust boundary is server-side). */
const FOTO_MAX_BYTES = 5 * 1024 * 1024;
const FOTOS_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Gap-pass-8: multipart POST /upload/perfil (the server bridges into
 * usuarios.subirFoto — image-signature chain + persona update in one home).
 * auth.me is the durable read-back (invalidated after the mutation).
 */
async function subirFotoPerfil(archivo: File): Promise<{ fotoKey: string; fotoUrl: string }> {
  const form = new FormData();
  form.append("file", archivo, archivo.name);
  const res = await authFetch(`${getServerUrl()}/upload/perfil`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `No se pudo subir la foto (HTTP ${res.status})`);
  }
  return (await res.json()) as { fotoKey: string; fotoUrl: string };
}

function FamiliaPropia({ db }: Readonly<{ db: RassaDatabase }>) {
  const session = useSession();
  const idUsuario = session.user?.id ?? "";
  const familias = useRxQueryLive<FamiliaDoc>({
    collection: db.familias,
    query: FAMILIAS_QUERY,
  });
  const membresias = useRxQueryLive<MembresiaDoc>({
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
    <p className="text-sm text-muted-foreground">
      Familia: {familia?.nombre ?? "Sin familia asignada"}
    </p>
  );
}

// Sexo values mirror the server's enum (usuarios SEXO zod schema).
const SEXO = { M: "M", F: "F", O: "O" } as const;
type Sexo = (typeof SEXO)[keyof typeof SEXO];

function esSexo(valor: string | null): valor is Sexo {
  return valor === SEXO.M || valor === SEXO.F || valor === SEXO.O;
}

// <input type="date"> needs 'YYYY-MM-DD'.
function fechaInput(valor: string | Date | null): string {
  if (!valor) return "";
  return new Date(valor).toISOString().slice(0, 10);
}

// Lax phone: digits, spaces and + only, ≤20 chars (server enforces the same rule).
const TELEFONO_VALIDO = /^[0-9+\s]{1,20}$/;

type OpcionLocalidad = { id: string; etiqueta: string };

// Gap-pass-8 UUID-label fix: the select must NEVER render the raw id. The picker
// source (localidadesPublicas) lists ACTIVE rows only, so when the user's current
// localidad is missing from it, the CURRENT localidad resolved by auth.me (exposed
// even when inactive) is appended as the extra option — labeled " (inactiva)".
function opcionesLocalidad(
  publicas: Array<{ id: string; nombre: string; municipio: string }>,
  actual: PerfilYo["persona"]["localidad"],
  valorActual: string,
): OpcionLocalidad[] {
  const lista = publicas.map((l) => ({ id: l.id, etiqueta: `${l.nombre} (${l.municipio})` }));
  if (valorActual && actual?.id === valorActual && !lista.some((l) => l.id === valorActual)) {
    lista.push({
      id: actual.id,
      etiqueta: `${actual.nombre} (${actual.municipio})${actual.estado ? "" : " (inactiva)"}`,
    });
  }
  return lista;
}

function FormularioPerfil(props: Readonly<{ yo: PerfilYo }>) {
  const queryClient = useQueryClient();
  const { yo } = props;
  const [nombre, setNombre] = useState(yo.persona.nombre);
  const [apellidoPaterno, setApellidoPaterno] = useState(yo.persona.apellidoPaterno);
  const [apellidoMaterno, setApellidoMaterno] = useState(yo.persona.apellidoMaterno ?? "");
  const [fkLocalidad, setFkLocalidad] = useState(yo.persona.fkLocalidad ?? "");
  const [telefono, setTelefono] = useState(yo.persona.telefono ?? "");
  const [fechaNacimiento, setFechaNacimiento] = useState(fechaInput(yo.persona.fechaNacimiento));
  const [sexo, setSexo] = useState<Sexo | undefined>(
    yo.persona.sexo && esSexo(yo.persona.sexo) ? yo.persona.sexo : undefined,
  );
  const [domicilio, setDomicilio] = useState(yo.persona.domicilio ?? "");
  const [error, setError] = useState<string | null>(null);

  // Localidad picker: same public read-only source as /registro.
  const localidades = useQuery(trpc.catalogos.localidadesPublicas.queryOptions());

  const guardar = useMutation(
    trpc.usuarios.updatePerfil.mutationOptions({
      onSuccess: () => {
        toast.success("Perfil actualizado");
        void queryClient.invalidateQueries();
      },
      onError: (error) => notificarError(error),
    }),
  );

  const enviar = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const telefonoLimpio = telefono.trim();
    if (telefonoLimpio && !TELEFONO_VALIDO.test(telefonoLimpio)) {
      setError("El teléfono solo admite dígitos, espacios y + (máximo 20 caracteres).");
      return;
    }
    if (fechaNacimiento && new Date(`${fechaNacimiento}T00:00:00`).getTime() >= Date.now()) {
      setError("La fecha de nacimiento debe ser una fecha pasada.");
      return;
    }
    setError(null);
    // T12b: me now exposes the gap-pass-7 persona fields, so the form always sends
    // them — null/empty clears the stored value instead of leaving it untouched.
    guardar.mutate({
      nombre: nombre.trim(),
      apellidoPaterno: apellidoPaterno.trim(),
      apellidoMaterno: apellidoMaterno.trim(),
      ...(fkLocalidad ? { fkLocalidad } : {}),
      telefono: telefonoLimpio || null,
      fechaNacimiento: fechaNacimiento || null,
      sexo: sexo ?? null,
      domicilio: domicilio.trim() || null,
    });
  };

  const opciones = opcionesLocalidad(localidades.data ?? [], yo.persona.localidad, fkLocalidad);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Datos personales</CardTitle>
        <CardDescription>Solo puedes editar tus propios datos personales.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={enviar} className="space-y-5">
          <div className="space-y-3">
            <p className="text-sm font-medium">Identidad</p>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="perfil-nombre">Nombre</Label>
                <Input
                  id="perfil-nombre"
                  value={nombre}
                  onChange={(event) => setNombre(event.target.value)}
                  placeholder="Tu nombre"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="perfil-ap">Apellido paterno</Label>
                <Input
                  id="perfil-ap"
                  value={apellidoPaterno}
                  onChange={(event) => setApellidoPaterno(event.target.value)}
                  placeholder="Primer apellido"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="perfil-am">Apellido materno</Label>
                <Input
                  id="perfil-am"
                  value={apellidoMaterno}
                  onChange={(event) => setApellidoMaterno(event.target.value)}
                  placeholder="Segundo apellido"
                />
              </div>
            </div>
          </div>
          <Separator />
          <div className="space-y-3">
            <p className="text-sm font-medium">Contacto y ubicación</p>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="perfil-telefono">Teléfono</Label>
                <Input
                  id="perfil-telefono"
                  type="tel"
                  maxLength={20}
                  value={telefono}
                  onChange={(event) => setTelefono(event.target.value)}
                  placeholder="951 000 0000"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="perfil-fecha-nacimiento">Fecha de nacimiento</Label>
                <Input
                  id="perfil-fecha-nacimiento"
                  type="date"
                  value={fechaNacimiento}
                  onChange={(event) => setFechaNacimiento(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="perfil-sexo">Sexo</Label>
                <Select
                  value={sexo ?? "none"}
                  onValueChange={(valor) => setSexo(esSexo(valor) ? valor : undefined)}
                >
                  <SelectTrigger id="perfil-sexo" className="w-full">
                    <SelectValue placeholder="Seleccione…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sin especificar</SelectItem>
                    <SelectItem value="M">Masculino</SelectItem>
                    <SelectItem value="F">Femenino</SelectItem>
                    <SelectItem value="O">Otro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="perfil-localidad">Localidad</Label>
                <Select
                  value={fkLocalidad === "" ? "none" : fkLocalidad}
                  onValueChange={(val) =>
                    setFkLocalidad(val === "none" || val == null ? "" : String(val))
                  }
                >
                  <SelectTrigger id="perfil-localidad" className="w-full">
                    <SelectValue placeholder="Seleccione una localidad…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sin localidad</SelectItem>
                    {opciones.map((opcion) => (
                      <SelectItem key={opcion.id} value={opcion.id}>
                        {opcion.etiqueta}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="perfil-domicilio">Domicilio</Label>
                <Textarea
                  id="perfil-domicilio"
                  maxLength={500}
                  value={domicilio}
                  onChange={(event) => setDomicilio(event.target.value)}
                  placeholder="Calle, número, referencias…"
                />
              </div>
            </div>
          </div>
          {error != null && <FormError>{error}</FormError>}
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
  const [error, setError] = useState<string | null>(null);

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
      onError: (error) => notificarError(error),
    }),
  );

  const enviar = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!actual || !nueva) {
      setError("Completa la contraseña actual y la nueva.");
      return;
    }
    setError(null);
    cambiar.mutate({ currentPassword: actual, newPassword: nueva });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Seguridad</CardTitle>
        <CardDescription>
          Cambiar contraseña — al hacerlo se cierran las sesiones activas en otros dispositivos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={enviar} className="space-y-3 max-w-xs">
          <div className="space-y-1.5">
            <Label htmlFor="perfil-pass-actual">Contraseña actual</Label>
            <PasswordInput
              id="perfil-pass-actual"
              autoComplete="current-password"
              value={actual}
              onChange={(event) => setActual(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="perfil-pass-nueva">Nueva contraseña</Label>
            <PasswordInput
              id="perfil-pass-nueva"
              autoComplete="new-password"
              value={nueva}
              onChange={(event) => setNueva(event.target.value)}
            />
          </div>
          {error != null && <FormError>{error}</FormError>}
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
