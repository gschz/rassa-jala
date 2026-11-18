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
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, useSession } from "@/lib/auth/session";
import { trpc } from "@/utils/trpc";

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
      <Card className="w-full max-w-sm">
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
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Solo Admin</CardTitle>
            <CardDescription>Solo el rol Admin puede administrar usuarios.</CardDescription>
          </CardHeader>
        </Card>
      </div>
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
      onError: (error) => toast.error(error.message),
    }),
  );
  const cambiarEstado = useMutation(
    trpc.usuarios.setEstado.mutationOptions({
      onSuccess: (_, variables) => {
        toast.success(variables.estado ? "Usuario activado" : "Usuario desactivado");
        invalidar();
      },
      onError: (error) => toast.error(error.message),
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
      onError: (error) => toast.error(error.message),
    }),
  );

  const aplicarBusqueda = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setBusquedaAplicada(busqueda.trim());
  };

  const usuarios = consulta.data?.usuarios ?? [];

  return (
    <div className="container mx-auto max-w-4xl space-y-6 px-4 py-4">
      <div>
        <h1 className="text-xl font-semibold">Administración de usuarios</h1>
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
                className="flex h-9 w-36 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
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
                className="flex h-9 w-32 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
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
    </div>
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
  if (props.usuarios.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin resultados.</p>;
  }
  return (
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
                    if (!window.confirm(`¿Cambiar el rol de ${u.correo} a ${nuevoRol}?`)) {
                      event.target.value = u.rol;
                      return;
                    }
                    props.onCambiarRol(u.id, nuevoRol);
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
                    if (
                      !window.confirm(
                        u.estado
                          ? `¿Desactivar a ${u.correo}? Sus sesiones activas se revocarán.`
                          : `¿Activar a ${u.correo}?`,
                      )
                    )
                      return;
                    props.onCambiarEstado(u.id, !u.estado);
                  }}
                >
                  {u.estado ? "Desactivar" : "Activar"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={props.restableciendo}
                  onClick={() => {
                    if (!window.confirm(`¿Generar una nueva contraseña para ${u.correo}?`)) return;
                    props.onRestablecer(u.id);
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
  const [generar, setGenerar] = useState(true);
  const [password, setPassword] = useState("");

  const localidades = useQuery(trpc.catalogos.localidadesPublicas.queryOptions());

  const crear = useMutation(
    trpc.usuarios.create.mutationOptions({
      onSuccess: (res) => {
        void queryClient.invalidateQueries();
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
        setPassword("");
        setGenerar(true);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const enviar = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const correo = email.trim().toLowerCase();
    if (!correo || !nombre.trim() || !apellidoPaterno.trim()) {
      toast.error("Completa correo, nombre y apellido paterno.");
      return;
    }
    if (!generar && password.length < 6) {
      toast.error("La contraseña debe tener al menos 6 caracteres.");
      return;
    }
    crear.mutate({
      email: correo,
      rol,
      nombre: nombre.trim(),
      apellidoPaterno: apellidoPaterno.trim(),
      ...(apellidoMaterno.trim() ? { apellidoMaterno: apellidoMaterno.trim() } : {}),
      ...(fkLocalidad ? { fkLocalidad } : {}),
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
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-rol">Rol</Label>
              <select
                id="nuevo-rol"
                value={rol}
                onChange={(event) => setRol(event.target.value as (typeof ROLES)[number])}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
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
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-ap">Apellido paterno</Label>
              <Input
                id="nuevo-ap"
                value={apellidoPaterno}
                onChange={(event) => setApellidoPaterno(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-am">Apellido materno</Label>
              <Input
                id="nuevo-am"
                value={apellidoMaterno}
                onChange={(event) => setApellidoMaterno(event.target.value)}
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
            <div className="space-y-1.5">
              <Label htmlFor="nuevo-password">Contraseña</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="nuevo-password"
                  type="text"
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
