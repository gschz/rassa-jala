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
import { Textarea } from "@rassa-jala/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormError } from "@/components/form-error";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { PageContainer } from "@/components/page-header";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/**
 * P0 Usuarios — admin management (Q-05/Q-07, online-confirm like /familias). The list
 * comes from usuarios.list on demand (server-paginated); the offline scoped roster stays
 * on the RxDB collections. One-time passwords (provisioning/reset) are shown ONCE in a
 * dialog with a copy button — the server never returns them again.
 */

export const Route = createFileRoute("/usuarios")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: UsuariosRoute,
});

const ROLES = ["Admin", "Agricultor", "Vendedor", "Cliente"] as const;

// Lax phone: digits, spaces and + only, ≤20 chars (server enforces the same rule).
const TELEFONO_VALIDO = /^[0-9+\s]{1,20}$/;

// Sexo values mirror the server's enum (usuarios SEXO zod schema).
const SEXO = { M: "M", F: "F", O: "O" } as const;
type Sexo = (typeof SEXO)[keyof typeof SEXO];

function esSexo(valor: string | null): valor is Sexo {
  return valor === SEXO.M || valor === SEXO.F || valor === SEXO.O;
}

type UsuarioLista = {
  id: string;
  correo: string;
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  rol: string;
  estado: boolean;
  debeCambiarPassword: boolean;
  familiaNombre: string | null;
  tieneLimite: boolean;
};

// Pending row confirmation behind the ConfirmDialog gate (replaces the native confirm dialog).
type AccionUsuarios =
  | { accion: "rol"; usuario: UsuarioLista; rol: (typeof ROLES)[number] }
  | { accion: "desactivar"; usuario: UsuarioLista }
  | { accion: "activar"; usuario: UsuarioLista }
  | { accion: "password"; usuario: UsuarioLista };

function confirmacionDe(pendiente: AccionUsuarios): {
  title: string;
  description?: string;
  confirmLabel: string;
  destructive: boolean;
} {
  switch (pendiente.accion) {
    case "rol":
      return {
        title: `¿Cambiar el rol de ${pendiente.usuario.correo}?`,
        description: `El rol pasará de ${pendiente.usuario.rol} a ${pendiente.rol}.`,
        confirmLabel: "Cambiar rol",
        destructive: false,
      };
    case "desactivar":
      return {
        title: `¿Desactivar a ${pendiente.usuario.correo}?`,
        description: "Sus sesiones activas se revocarán.",
        confirmLabel: "Desactivar",
        destructive: true,
      };
    case "activar":
      return {
        title: `¿Activar a ${pendiente.usuario.correo}?`,
        confirmLabel: "Activar",
        destructive: false,
      };
    case "password":
      return {
        title: "¿Generar una nueva contraseña?",
        description: `Se generará para ${pendiente.usuario.correo} y se mostrará una sola vez.`,
        confirmLabel: "Generar",
        destructive: false,
      };
  }
}

// One-time password surface (Q-07): shown once, never stored in app state beyond this
// dialog; the copy button uses the platform clipboard.
function DialogoPassword(
  props: Readonly<{ titulo: string; password: string; onClose: () => void }>,
) {
  const copiar = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.password);
      toast.success("Contraseña copiada al portapapeles");
    } catch {
      toast.error("No se pudo copiar; cópiala manualmente.");
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <Card className="max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto">
        <CardHeader>
          <CardTitle>{props.titulo}</CardTitle>
          <CardDescription>
            Esta contraseña se muestra UNA sola vez. Compártela de forma segura; después de su
            primer inicio de sesión el usuario deberá cambiarla.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <code className="block select-all rounded-md border bg-muted px-3 py-2 text-center text-sm font-mono">
            {props.password}
          </code>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => void copiar()}>
              Copiar
            </Button>
            <Button className="flex-1" onClick={props.onClose}>
              Cerrar
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UsuariosRoute() {
  const session = useSession();
  if (session.user?.rol !== "Admin") {
    return (
      <PageContainer>
        <Card>
          <CardHeader>
            <CardTitle>Solo Admin</CardTitle>
            <CardDescription>Solo el rol Admin puede administrar usuarios.</CardDescription>
          </CardHeader>
        </Card>
      </PageContainer>
    );
  }
  return <UsuariosAdmin />;
}

function UsuariosAdmin() {
  const queryClient = useQueryClient();
  const session = useSession();
  const [busqueda, setBusqueda] = useState("");
  const [busquedaAplicada, setBusquedaAplicada] = useState("");
  const [rolFiltro, setRolFiltro] = useState("");
  const [estadoFiltro, setEstadoFiltro] = useState("");
  const [passwordUnaVez, setPasswordUnaVez] = useState<{
    titulo: string;
    password: string;
  } | null>(null);

  const consulta = useQuery(
    trpc.usuarios.list.queryOptions({
      ...(busquedaAplicada ? { search: busquedaAplicada } : {}),
      ...(rolFiltro ? { rol: rolFiltro as (typeof ROLES)[number] } : {}),
      ...(estadoFiltro ? { estado: estadoFiltro === "activos" } : {}),
    }),
  );

  const invalidar = (): void => {
    void queryClient.invalidateQueries();
  };

  const cambiarRol = useMutation(
    trpc.usuarios.changeRol.mutationOptions({
      onSuccess: () => {
        toast.success("Rol actualizado");
        invalidar();
      },
      onError: (error) => notificarError(error),
    }),
  );
  const cambiarEstado = useMutation(
    trpc.usuarios.setEstado.mutationOptions({
      onSuccess: (_, variables) => {
        toast.success(variables.estado ? "Usuario activado" : "Usuario desactivado");
        invalidar();
      },
      onError: (error) => notificarError(error),
    }),
  );
  const restablecer = useMutation(
    trpc.usuarios.resetPassword.mutationOptions({
      onSuccess: (res) => {
        invalidar();
        if (res.passwordInicial) {
          setPasswordUnaVez({
            titulo: "Nueva contraseña generada",
            password: res.passwordInicial,
          });
        } else {
          toast.success("Contraseña restablecida");
        }
      },
      onError: (error) => notificarError(error),
    }),
  );

  const aplicarBusqueda = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setBusquedaAplicada(busqueda.trim());
  };

  const usuarios = consulta.data?.usuarios ?? [];

  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Usuarios</h1>
        <p className="text-sm text-muted-foreground">
          Roles, altas y bajas de usuarios. La contraseña inicial se genera aquí y se muestra una
          sola vez; el usuario deberá cambiarla al entrar.
        </p>
      </div>

      <FormularioCreacion
        onPasswordGenerada={(password) =>
          setPasswordUnaVez({ titulo: "Contraseña inicial generada", password })
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Usuarios</CardTitle>
          <CardDescription>
            {consulta.data
              ? `${consulta.data.total} usuarios coinciden con el filtro.`
              : "Cargando…"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={aplicarBusqueda} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="usuarios-busqueda">Buscar</Label>
              <Input
                id="usuarios-busqueda"
                value={busqueda}
                onChange={(event) => setBusqueda(event.target.value)}
                placeholder="correo o nombre"
                className="w-56"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="usuarios-rol">Rol</Label>
              <select
                id="usuarios-rol"
                value={rolFiltro}
                onChange={(event) => setRolFiltro(event.target.value)}
                className="flex h-10 w-36 rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                <option value="">Todos</option>
                {ROLES.map((rol) => (
                  <option key={rol} value={rol}>
                    {rol}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="usuarios-estado">Estado</Label>
              <select
                id="usuarios-estado"
                value={estadoFiltro}
                onChange={(event) => setEstadoFiltro(event.target.value)}
                className="flex h-10 w-32 rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                <option value="">Todos</option>
                <option value="activos">Activos</option>
                <option value="inactivos">Inactivos</option>
              </select>
            </div>
            <Button type="submit" variant="outline" size="sm">
              Filtrar
            </Button>
          </form>

          {consulta.isPending ? (
            <div className="flex justify-center py-8">
              <Loader2 className="animate-spin" />
            </div>
          ) : (
            <TablaUsuarios
              usuarios={usuarios}
              idPropio={session.user?.id ?? ""}
              cambiandoRol={cambiarRol.isPending}
              cambiandoEstado={cambiarEstado.isPending}
              restableciendo={restablecer.isPending}
              onCambiarRol={(id, rol) => cambiarRol.mutate({ id, rol })}
              onCambiarEstado={(id, estado) => cambiarEstado.mutate({ id, estado })}
              onRestablecer={(id) => restablecer.mutate({ id, generate: true })}
            />
          )}
        </CardContent>
      </Card>

      {passwordUnaVez && (
        <DialogoPassword
          titulo={passwordUnaVez.titulo}
          password={passwordUnaVez.password}
          onClose={() => setPasswordUnaVez(null)}
        />
      )}
    </PageContainer>
  );
}

function TablaUsuarios(
  props: Readonly<{
    usuarios: UsuarioLista[];
    idPropio: string;
    cambiandoRol: boolean;
    cambiandoEstado: boolean;
    restableciendo: boolean;
    onCambiarRol: (id: string, rol: (typeof ROLES)[number]) => void;
    onCambiarEstado: (id: string, estado: boolean) => void;
    onRestablecer: (id: string) => void;
  }>,
) {
  const [pendiente, setPendiente] = useState<AccionUsuarios | null>(null);
  if (props.usuarios.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin resultados.</p>;
  }
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-medium">Correo</th>
              <th className="py-1 pr-3 font-medium">Nombre</th>
              <th className="py-1 pr-3 font-medium">Rol</th>
              <th className="py-1 pr-3 font-medium">Estado</th>
              <th className="py-1 pr-3 font-medium">Familia</th>
              <th className="py-1 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {props.usuarios.map((u) => (
              <tr key={u.id} className="border-t">
                <td className="py-1.5 pr-3">
                  {u.correo}
                  {u.debeCambiarPassword && (
                    <span className="ml-2 rounded-full border px-2 py-0.5 text-xs text-amber-600">
                      Cambio pendiente
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  {u.nombre} {u.apellidoPaterno}
                </td>
                <td className="py-1.5 pr-3">
                  <select
                    aria-label={`Rol de ${u.correo}`}
                    value={u.rol}
                    disabled={u.id === props.idPropio || props.cambiandoRol}
                    onChange={(event) => {
                      const nuevoRol = event.target.value as (typeof ROLES)[number];
                      if (nuevoRol === u.rol) return;
                      // Controlled select: the re-render restores the current rol
                      // if the user cancels the confirmation.
                      setPendiente({ accion: "rol", usuario: u, rol: nuevoRol });
                    }}
                    className="flex h-8 w-32 rounded-md border border-input bg-transparent px-2 py-0 text-xs"
                  >
                    {ROLES.map((rol) => (
                      <option key={rol} value={rol}>
                        {rol}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 pr-3">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      u.estado ? "text-emerald-600" : "text-red-500"
                    }`}
                  >
                    {u.estado ? "Activo" : "Inactivo"}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-muted-foreground">{u.familiaNombre ?? "—"}</td>
                <td className="flex gap-1 py-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={u.id === props.idPropio || props.cambiandoEstado}
                    onClick={() => {
                      setPendiente(
                        u.estado
                          ? { accion: "desactivar", usuario: u }
                          : { accion: "activar", usuario: u },
                      );
                    }}
                  >
                    {u.estado ? "Desactivar" : "Activar"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={props.restableciendo}
                    onClick={() => {
                      setPendiente({ accion: "password", usuario: u });
                    }}
                  >
                    Restablecer contraseña
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pendiente && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendiente(null);
          }}
          {...confirmacionDe(pendiente)}
          onConfirm={() => {
            if (pendiente.accion === "rol") {
              props.onCambiarRol(pendiente.usuario.id, pendiente.rol);
            } else if (pendiente.accion === "password") {
              props.onRestablecer(pendiente.usuario.id);
            } else {
              props.onCambiarEstado(pendiente.usuario.id, pendiente.accion === "activar");
            }
            setPendiente(null);
          }}
        />
      )}
    </>
  );
}

function FormularioCreacion(props: Readonly<{ onPasswordGenerada: (password: string) => void }>) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [rol, setRol] = useState<(typeof ROLES)[number]>("Cliente");
  const [nombre, setNombre] = useState("");
  const [apellidoPaterno, setApellidoPaterno] = useState("");
  const [apellidoMaterno, setApellidoMaterno] = useState("");
  const [fkLocalidad, setFkLocalidad] = useState("");
  const [telefono, setTelefono] = useState("");
  const [fechaNacimiento, setFechaNacimiento] = useState("");
  const [sexo, setSexo] = useState<Sexo | undefined>(undefined);
  const [domicilio, setDomicilio] = useState("");
  const [generar, setGenerar] = useState(true);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const localidades = useQuery(trpc.catalogos.localidadesPublicas.queryOptions());

  const crear = useMutation(
    trpc.usuarios.create.mutationOptions({
      onSuccess: (res) => {
        void queryClient.invalidateQueries();
        setError(null);
        if (res.passwordInicial) {
          props.onPasswordGenerada(res.passwordInicial);
        } else {
          toast.success(`Usuario ${res.correo} creado`);
        }
        setEmail("");
        setNombre("");
        setApellidoPaterno("");
        setApellidoMaterno("");
        setFkLocalidad("");
        setTelefono("");
        setFechaNacimiento("");
        setSexo(undefined);
        setDomicilio("");
        setPassword("");
        setGenerar(true);
      },
      onError: (error) => notificarError(error),
    }),
  );

  const enviar = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const correo = email.trim().toLowerCase();
    if (!correo || !nombre.trim() || !apellidoPaterno.trim()) {
      setError("Completa correo, nombre y apellido paterno.");
      return;
    }
    if (!generar && password.length < 6) {
      setError("La contraseña debe tener al menos 6 caracteres.");
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
    setError(null);
    crear.mutate({
      email: correo,
      rol,
      nombre: nombre.trim(),
      apellidoPaterno: apellidoPaterno.trim(),
      ...(apellidoMaterno.trim() ? { apellidoMaterno: apellidoMaterno.trim() } : {}),
      ...(fkLocalidad ? { fkLocalidad } : {}),
      ...(telefonoLimpio ? { telefono: telefonoLimpio } : {}),
      ...(fechaNacimiento ? { fechaNacimiento } : {}),
      ...(sexo ? { sexo } : {}),
      ...(domicilio.trim() ? { domicilio: domicilio.trim() } : {}),
      ...(generar ? { generate: true } : { password }),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nuevo usuario</CardTitle>
        <CardDescription>
          Alta de Vendedor, Agricultor, Cliente o Admin. Si generas la contraseña, se muestra una
          sola vez tras crear la cuenta.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={enviar} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-email">Correo electrónico</Label>
              <Input
                id="nuevo-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="correo@ejemplo.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-rol">Rol</Label>
              <select
                id="nuevo-rol"
                value={rol}
                onChange={(event) => setRol(event.target.value as (typeof ROLES)[number])}
                className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-nombre">Nombre</Label>
              <Input
                id="nuevo-nombre"
                value={nombre}
                onChange={(event) => setNombre(event.target.value)}
                placeholder="Tu nombre"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-ap">Apellido paterno</Label>
              <Input
                id="nuevo-ap"
                value={apellidoPaterno}
                onChange={(event) => setApellidoPaterno(event.target.value)}
                placeholder="Primer apellido"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-am">Apellido materno</Label>
              <Input
                id="nuevo-am"
                value={apellidoMaterno}
                onChange={(event) => setApellidoMaterno(event.target.value)}
                placeholder="Segundo apellido"
              />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-localidad">Localidad (opcional)</Label>
              <select
                id="nuevo-localidad"
                value={fkLocalidad}
                onChange={(event) => setFkLocalidad(event.target.value)}
                className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                <option value="">Sin localidad</option>
                {(localidades.data ?? []).map((localidad) => (
                  <option key={localidad.id} value={localidad.id}>
                    {localidad.nombre} ({localidad.municipio})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-password">Contraseña</Label>
              <div className="flex items-center gap-2">
                <PasswordInput
                  id="nuevo-password"
                  value={generar ? "" : password}
                  disabled={generar}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={generar ? "Se generará automáticamente" : "Mínimo 6 caracteres"}
                />
                <label className="flex shrink-0 items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={generar}
                    onChange={(event) => setGenerar(event.target.checked)}
                  />
                  Generar
                </label>
              </div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-telefono">Teléfono (opcional)</Label>
              <Input
                id="nuevo-telefono"
                type="tel"
                maxLength={20}
                value={telefono}
                onChange={(event) => setTelefono(event.target.value)}
                placeholder="951 000 0000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-fecha-nacimiento">Fecha de nacimiento (opcional)</Label>
              <Input
                id="nuevo-fecha-nacimiento"
                type="date"
                value={fechaNacimiento}
                onChange={(event) => setFechaNacimiento(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-sexo">Sexo (opcional)</Label>
              <select
                id="nuevo-sexo"
                value={sexo ?? ""}
                onChange={(event) =>
                  setSexo(esSexo(event.target.value) ? event.target.value : undefined)
                }
                className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-xs"
              >
                <option value="">Sin especificar</option>
                <option value="M">Masculino</option>
                <option value="F">Femenino</option>
                <option value="O">Otro</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nuevo-domicilio">Domicilio (opcional)</Label>
            <Textarea
              id="nuevo-domicilio"
              maxLength={500}
              value={domicilio}
              onChange={(event) => setDomicilio(event.target.value)}
              placeholder="Calle, número, referencias…"
            />
          </div>
          {error != null && <FormError>{error}</FormError>}
          <Button type="submit" disabled={crear.isPending}>
            {crear.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              "Crear usuario"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
