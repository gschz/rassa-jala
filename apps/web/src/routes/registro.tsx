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
import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { getAccessToken } from "@/lib/auth/session";
import { trpc } from "@/utils/trpc";

/**
 * P0 Usuarios — Q-05 public registration (Cliente only). Online-confirm: the mutation
 * validates the active localidad server-side and rejects duplicate emails; the new user
 * signs in afterwards. No session is issued here.
 */
export const Route = createFileRoute("/registro")({
  beforeLoad: () => {
    if (getAccessToken()) throw redirect({ to: "/" });
  },
  component: RegistroPage,
});

function RegistroPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [nombre, setNombre] = useState("");
  const [apellidoPaterno, setApellidoPaterno] = useState("");
  const [apellidoMaterno, setApellidoMaterno] = useState("");
  const [fkLocalidad, setFkLocalidad] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Public read-only picker (PULL requires auth; registration is an anonymous flow).
  const localidades = useQuery(trpc.catalogos.localidadesPublicas.queryOptions());

  const registrar = useMutation(
    trpc.usuarios.register.mutationOptions({
      onSuccess: (res) => {
        toast.success(`Cuenta creada para ${res.correo}; inicia sesión.`);
        void navigate({ to: "/login" });
      },
      onError: (err) => setError(err.message),
    }),
  );

  const enviar = (event: FormEvent<HTMLFormElement>): void => {
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
    registrar.mutate({
      email: correo,
      password,
      nombre: nombre.trim(),
      apellidoPaterno: apellidoPaterno.trim(),
      ...(apellidoMaterno.trim() ? { apellidoMaterno: apellidoMaterno.trim() } : {}),
      fkLocalidad,
    });
  };

  return (
    <div className="flex h-full items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Crear cuenta</CardTitle>
          <CardDescription>
            Regístrate como cliente de RassaJala. Las cuentas de Vendedor y Agricultor las emite el
            administrador.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                <Input
                  id="registro-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="registro-confirm">Confirmar contraseña</Label>
                <Input
                  id="registro-confirm"
                  type="password"
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
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="registro-ap">Apellido paterno</Label>
                <Input
                  id="registro-ap"
                  value={apellidoPaterno}
                  onChange={(event) => setApellidoPaterno(event.target.value)}
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
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="registro-localidad">Localidad</Label>
                <select
                  id="registro-localidad"
                  value={fkLocalidad}
                  onChange={(event) => setFkLocalidad(event.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                >
                  <option value="" disabled>
                    Seleccione una localidad…
                  </option>
                  {(localidades.data ?? []).map((localidad) => (
                    <option key={localidad.id} value={localidad.id}>
                      {localidad.nombre} ({localidad.municipio})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {error != null && (
              <p role="alert" className="text-sm text-red-500">
                {error}
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
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
        </CardContent>
      </Card>
    </div>
  );
}
