import { Alert, AlertDescription } from "@rassa-jala/ui/components/alert";
import { Button } from "@rassa-jala/ui/components/button";
import { Input } from "@rassa-jala/ui/components/input";
import { Label } from "@rassa-jala/ui/components/label";
import { PasswordInput } from "@rassa-jala/ui/components/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rassa-jala/ui/components/select";
import { Textarea } from "@rassa-jala/ui/components/textarea";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { AlertCircle, Loader2, Sprout } from "lucide-react";
import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";

import { getAccessToken } from "@/lib/auth/session";
import { trpc } from "@/utils/trpc";
import { mensajeDeError } from "@/lib/notificar-error";

/**
 * P0 Usuarios — Q-05 public registration (Cliente only). Online-confirm: the mutation
 * validates the active localidad server-side and rejects duplicate emails; the new user
 * signs in afterwards. No session is issued here. Layout redesigned per design doc §7
 * (split identity|form on desktop, compact brand header on mobile) — the flow,
 * validations and mutation are untouched.
 */
export const Route = createFileRoute("/registro")({
  beforeLoad: () => {
    if (getAccessToken()) throw redirect({ to: "/" });
  },
  component: RegistroPage,
});

// Lax phone: digits, spaces and + only, ≤20 chars (server enforces the same rule).
const TELEFONO_VALIDO = /^[0-9+\s]{1,20}$/;

// Sexo values mirror the server's enum (usuarios SEXO zod schema).
const SEXO = { M: "M", F: "F", O: "O" } as const;
type Sexo = (typeof SEXO)[keyof typeof SEXO];

function esSexo(valor: string | null): valor is Sexo {
  return valor === SEXO.M || valor === SEXO.F || valor === SEXO.O;
}

function MarcaPanel() {
  return (
    <div className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground md:flex">
      <div className="flex items-center gap-3">
        <span
          className="flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary"
          aria-hidden
        >
          <Sprout className="size-6" />
        </span>
        <p className="text-lg font-semibold tracking-tight">RassaJala</p>
      </div>
      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Conectamos productores locales con compradores directos.
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Crea tu cuenta de cliente y compra directamente a productores de tu localidad.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Las cuentas de Vendedor y Agricultor las emite el administrador.
      </p>
    </div>
  );
}

function MarcaCompacta() {
  return (
    <div className="flex flex-col items-center gap-1.5 pt-10 pb-6 text-center md:hidden">
      <span
        className="flex size-11 items-center justify-center rounded-lg bg-primary/15 text-primary"
        aria-hidden
      >
        <Sprout className="size-6" />
      </span>
      <p className="text-lg font-semibold tracking-tight">RassaJala</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Conectamos productores locales con compradores directos.
      </p>
    </div>
  );
}

function RegistroPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [nombre, setNombre] = useState("");
  const [apellidoPaterno, setApellidoPaterno] = useState("");
  const [apellidoMaterno, setApellidoMaterno] = useState("");
  const [fkLocalidad, setFkLocalidad] = useState("");
  const [telefono, setTelefono] = useState("");
  const [fechaNacimiento, setFechaNacimiento] = useState("");
  const [sexo, setSexo] = useState<Sexo | undefined>(undefined);
  const [domicilio, setDomicilio] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Public read-only picker (PULL requires auth; registration is an anonymous flow).
  const localidades = useQuery(trpc.catalogos.localidadesPublicas.queryOptions());

  const registrar = useMutation(
    trpc.usuarios.register.mutationOptions({
      onSuccess: (res) => {
        toast.success(`Cuenta creada para ${res.correo}; inicia sesión.`);
        void navigate({ to: "/login" });
      },
      onError: (err) => setError(mensajeDeError(err)),
    }),
  );

  const enviar = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);
    const correo = email.trim().toLowerCase();
    if (!correo || !password || !nombre.trim() || !apellidoPaterno.trim() || !fkLocalidad) {
      setError("Completa los campos obligatorios.");
      return;
    }
    if (password !== confirmacion) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    const telefonoLimpio = telefono.trim();
    if (telefonoLimpio && !TELEFONO_VALIDO.test(telefonoLimpio)) {
      setError("El teléfono solo admite dígitos, espacios y + (máximo 20 caracteres).");
      return;
    }
    if (fechaNacimiento && new Date(`${fechaNacimiento}T00:00:00`).getTime() >= Date.now()) {
      setError("La fecha de nacimiento debe ser una fecha pasada.");
      return;
    }
    registrar.mutate({
      email: correo,
      password,
      nombre: nombre.trim(),
      apellidoPaterno: apellidoPaterno.trim(),
      ...(apellidoMaterno.trim() ? { apellidoMaterno: apellidoMaterno.trim() } : {}),
      fkLocalidad,
      ...(telefonoLimpio ? { telefono: telefonoLimpio } : {}),
      ...(fechaNacimiento ? { fechaNacimiento } : {}),
      ...(sexo ? { sexo } : {}),
      ...(domicilio.trim() ? { domicilio: domicilio.trim() } : {}),
    });
  };

  return (
    <div className="grid h-full md:grid-cols-2">
      <MarcaPanel />
      <div className="flex h-full flex-col items-center overflow-y-auto px-4 justify-center">
        <MarcaCompacta />
        <div className="w-full max-w-md space-y-4 pb-10 md:pb-0">
          <div className="space-y-1.5">
            <h1 className="text-section font-semibold tracking-tight">Crear cuenta</h1>
            <p className="text-sm text-muted-foreground">
              Regístrate como cliente de RassaJala. Las cuentas de Vendedor y Agricultor las emite
              el administrador.
            </p>
          </div>
          <form onSubmit={enviar} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="registro-email">Correo electrónico</Label>
              <Input
                id="registro-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="correo@ejemplo.com"
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="registro-password">Contraseña</Label>
                <PasswordInput
                  id="registro-password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="registro-confirm">Confirmar contraseña</Label>
                <PasswordInput
                  id="registro-confirm"
                  autoComplete="new-password"
                  value={confirmacion}
                  onChange={(event) => setConfirmacion(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="registro-nombre">Nombre</Label>
                <Input
                  id="registro-nombre"
                  value={nombre}
                  onChange={(event) => setNombre(event.target.value)}
                  placeholder="Tu nombre"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="registro-ap">Apellido paterno</Label>
                <Input
                  id="registro-ap"
                  value={apellidoPaterno}
                  onChange={(event) => setApellidoPaterno(event.target.value)}
                  placeholder="Primer apellido"
                />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="registro-am">Apellido materno (opcional)</Label>
                <Input
                  id="registro-am"
                  value={apellidoMaterno}
                  onChange={(event) => setApellidoMaterno(event.target.value)}
                  placeholder="Segundo apellido"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="registro-localidad">Localidad</Label>
                <Select
                  value={fkLocalidad === "" ? null : fkLocalidad}
                  onValueChange={(valor) => setFkLocalidad(valor == null ? "" : String(valor))}
                >
                  <SelectTrigger id="registro-localidad" className="w-full">
                    <SelectValue placeholder="Seleccione una localidad…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(localidades.data ?? []).map((localidad) => (
                      <SelectItem key={localidad.id} value={localidad.id}>
                        {localidad.nombre} ({localidad.municipio})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="registro-telefono">Teléfono (opcional)</Label>
                <Input
                  id="registro-telefono"
                  type="tel"
                  maxLength={20}
                  value={telefono}
                  onChange={(event) => setTelefono(event.target.value)}
                  placeholder="951 000 0000"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="registro-fecha-nacimiento">Fecha de nacimiento (opcional)</Label>
                <Input
                  id="registro-fecha-nacimiento"
                  type="date"
                  value={fechaNacimiento}
                  onChange={(event) => setFechaNacimiento(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="registro-sexo">Sexo (opcional)</Label>
                <Select
                  value={sexo ?? "none"}
                  onValueChange={(valor) => setSexo(esSexo(valor) ? valor : undefined)}
                >
                  <SelectTrigger id="registro-sexo" className="w-full">
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
              <div className="space-y-1.5">
                <Label htmlFor="registro-domicilio">Domicilio (opcional)</Label>
                <Textarea
                  id="registro-domicilio"
                  maxLength={500}
                  value={domicilio}
                  onChange={(event) => setDomicilio(event.target.value)}
                  placeholder="Calle, número, referencias…"
                />
              </div>
            </div>
            {error != null && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button
              type="submit"
              className="w-full h-10"
              disabled={registrar.isPending || localidades.isPending}
            >
              {registrar.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                "Crear cuenta"
              )}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              ¿Ya tienes cuenta?{" "}
              <Link to="/login" className="underline">
                Inicia sesión
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
