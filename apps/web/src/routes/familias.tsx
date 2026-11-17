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
 * P0 Familias — admin CRUD (docs/scope.md §3.1 "Familias y permisos — CONSERVAR reforzado").
 *
 * Online-confirm mutations against the server (same architecture as /catalogos): the UI
 * never writes RxDB for these and marks nothing confirmed before the server answers; the
 * list query refetches after every mutation. The offline scoped view (own family) lives on
 * the home page and reads the RxDB collections filled by PULL.
 */

export const Route = createFileRoute("/familias")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
  },
  component: FamiliasRoute,
});

// Local view types matching the server DTO (familias.list).
type MiembroLista = {
  membresiaId: string;
  usuarioId: string;
  correo: string;
  esJefe: boolean;
  estado: boolean;
  version: number;
};

type LimiteLista = {
  id: string;
  monto: string;
  estado: boolean;
  version: number;
};

type FamiliaLista = {
  id: string;
  nombre: string;
  fkJefeUsuario: string | null;
  estado: boolean;
  version: number;
  limite: LimiteLista | null;
  miembros: MiembroLista[];
};

// F-29: money is stored/transported as string; Number() here is display-only.
function formatearMonto(monto: string): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    Number(monto),
  );
}

function FamiliasRoute() {
  const session = useSession();
  if (session.user?.rol !== "Admin") {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Solo Admin</CardTitle>
            <CardDescription>Solo el rol Admin puede administrar las familias.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }
  return <FamiliasAdmin />;
}

function FamiliasAdmin() {
  const queryClient = useQueryClient();
  const consulta = useQuery(trpc.familias.list.queryOptions({ incluirInactivas: true }));

  const invalidar = (): void => {
    void queryClient.invalidateQueries();
  };

  const crear = useMutation(
    trpc.familias.create.mutationOptions({
      onSuccess: () => {
        toast.success("Familia creada");
        invalidar();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const cambiarEstado = useMutation(
    trpc.familias.setEstado.mutationOptions({
      onSuccess: (resultado, variables) => {
        if (variables.estado) {
          toast.success(
            resultado.omitidos.length > 0
              ? `Familia restaurada; sin restaurar: ${resultado.omitidos.join(", ")} (ya pertenecen a otra familia)`
              : "Familia restaurada",
          );
        } else {
          toast.success("Familia desactivada");
        }
        invalidar();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const familias = consulta.data ?? [];
  const activas = familias.filter((f) => f.estado);
  const inactivas = familias.filter((f) => !f.estado);

  return (
    <div className="container mx-auto max-w-4xl space-y-6 px-4 py-4">
      <div>
        <h1 className="text-xl font-semibold">Administración de familias</h1>
        <p className="text-sm text-muted-foreground">
          Una familia agrupa usuarios alrededor de un jefe y un límite de crédito compartido. Un
          usuario pertenece como máximo a una familia activa.
        </p>
      </div>

      <FormularioNuevaFamilia
        creando={crear.isPending}
        onCrear={(valores) =>
          crear.mutateAsync({
            nombre: valores.nombre,
            jefeEmail: valores.jefeEmail,
            ...(valores.montoLimite !== undefined ? { montoLimite: valores.montoLimite } : {}),
          })
        }
      />

      {consulta.isPending ? (
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <>
          {activas.map((familia) => (
            <TarjetaFamilia
              key={familia.id}
              familia={familia}
              onInvalidar={invalidar}
              cambiandoEstado={cambiarEstado.isPending}
              onSetEstado={(estado) =>
                cambiarEstado.mutate({ familiaId: familia.id, version: familia.version, estado })
              }
            />
          ))}
          {activas.length === 0 && (
            <p className="text-sm text-muted-foreground">No hay familias activas todavía.</p>
          )}

          {inactivas.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Papelera</CardTitle>
                <CardDescription>
                  Las familias desactivadas se conservan (soft-delete) y pueden restaurarse; los
                  miembros que entraron a otra familia mientras tanto no se restauran.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {inactivas.map((familia) => (
                  <div
                    key={familia.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2"
                  >
                    <span className="text-sm">
                      {familia.nombre}
                      <span className="text-muted-foreground"> · v{familia.version}</span>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={cambiarEstado.isPending}
                      onClick={() => {
                        if (!window.confirm(`¿Restaurar "${familia.nombre}"?`)) return;
                        cambiarEstado.mutate({
                          familiaId: familia.id,
                          version: familia.version,
                          estado: true,
                        });
                      }}
                    >
                      Restaurar
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function FormularioNuevaFamilia(
  props: Readonly<{
    creando: boolean;
    onCrear: (valores: {
      nombre: string;
      jefeEmail: string;
      montoLimite?: number;
    }) => Promise<unknown>;
  }>,
) {
  const [nombre, setNombre] = useState("");
  const [jefeEmail, setJefeEmail] = useState("");
  const [monto, setMonto] = useState("");
  const [enviando, setEnviando] = useState(false);

  const enviar = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nombreTrim = nombre.trim();
    const correo = jefeEmail.trim().toLowerCase();
    if (!nombreTrim || !correo || enviando || props.creando) return;
    const montoNumero = monto.trim() === "" ? undefined : Number(monto.replace(",", "."));
    if (montoNumero !== undefined && (!Number.isFinite(montoNumero) || montoNumero < 0)) {
      toast.error("El monto del límite debe ser un número mayor o igual a 0");
      return;
    }
    setEnviando(true);
    void props
      .onCrear({ nombre: nombreTrim, jefeEmail: correo, montoLimite: montoNumero })
      .then(() => {
        // Clear only after the server CONFIRMS the creation.
        setNombre("");
        setJefeEmail("");
        setMonto("");
      })
      .catch(() => {
        // Error toast handled by the parent mutation's onError; keep the values.
      })
      .finally(() => setEnviando(false));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nueva familia</CardTitle>
        <CardDescription>
          Crea la familia con su jefe, su límite opcional y la conversación grupal del hogar.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={enviar} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="familia-nombre">Nombre</Label>
              <Input
                id="familia-nombre"
                value={nombre}
                onChange={(event) => setNombre(event.target.value)}
                placeholder="Nombre de la familia"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="familia-jefe">Correo del jefe</Label>
              <Input
                id="familia-jefe"
                type="email"
                value={jefeEmail}
                onChange={(event) => setJefeEmail(event.target.value)}
                placeholder="jefe@correo.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="familia-monto">Límite de crédito (opcional)</Label>
              <Input
                id="familia-monto"
                inputMode="decimal"
                value={monto}
                onChange={(event) => setMonto(event.target.value)}
                placeholder="5000.00"
              />
            </div>
          </div>
          <Button
            type="submit"
            disabled={enviando || props.creando || !nombre.trim() || !jefeEmail.trim()}
          >
            {enviando || props.creando ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              "Crear familia"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function TarjetaFamilia(
  props: Readonly<{
    familia: FamiliaLista;
    onInvalidar: () => void;
    cambiandoEstado: boolean;
    onSetEstado: (estado: boolean) => void;
  }>,
) {
  const { familia } = props;
  const activos = familia.miembros.filter((m) => m.estado);
  const inactivos = familia.miembros.filter((m) => !m.estado);

  const desactivar = (): void => {
    if (
      !window.confirm(`¿Desactivar "${familia.nombre}"? Todos sus miembros quedarán dados de baja.`)
    )
      return;
    props.onSetEstado(false);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              {familia.nombre}
              <span className="rounded-full border px-2 py-0.5 text-xs font-normal text-emerald-600">
                Activa
              </span>
            </CardTitle>
            <CardDescription>
              {activos.length} {activos.length === 1 ? "miembro" : "miembros"} · v{familia.version}
            </CardDescription>
          </div>
          <div className="flex gap-1">
            <SeccionLimite familia={familia} onInvalidar={props.onInvalidar} />
            <Button
              variant="outline"
              size="sm"
              disabled={props.cambiandoEstado}
              onClick={desactivar}
            >
              Desactivar
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <SeccionMiembros familia={familia} onInvalidar={props.onInvalidar} />
        {inactivos.length > 0 && (
          <SeccionMiembrosInactivos familia={familia} onInvalidar={props.onInvalidar} />
        )}
      </CardContent>
    </Card>
  );
}

function SeccionLimite(props: Readonly<{ familia: FamiliaLista; onInvalidar: () => void }>) {
  const queryClient = useQueryClient();
  const [editando, setEditando] = useState(false);
  const [monto, setMonto] = useState("");
  const limite = props.familia.limite;

  const guardar = useMutation(
    trpc.familias.setLimite.mutationOptions({
      onSuccess: () => {
        toast.success("Límite de crédito guardado");
        setEditando(false);
        void queryClient.invalidateQueries();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const enviar = (): void => {
    const montoNumero = Number(monto.replace(",", "."));
    if (!Number.isFinite(montoNumero) || montoNumero < 0) {
      toast.error("El monto debe ser un número mayor o igual a 0");
      return;
    }
    guardar.mutate({
      familiaId: props.familia.id,
      monto: montoNumero,
      // CAS on the existing limit; absent version = create path.
      ...(limite ? { version: limite.version } : {}),
    });
  };

  if (editando) {
    return (
      <span className="flex items-center gap-1">
        <Input
          className="h-8 w-32"
          inputMode="decimal"
          autoFocus
          value={monto}
          onChange={(event) => setMonto(event.target.value)}
          placeholder={limite ? limite.monto : "0.00"}
        />
        <Button size="sm" disabled={guardar.isPending} onClick={enviar}>
          {guardar.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : "OK"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditando(false);
            setMonto("");
          }}
        >
          Cancelar
        </Button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-sm">
      <span className="text-muted-foreground">Límite:</span>
      <span>{limite ? formatearMonto(limite.monto) : "Sin límite"}</span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setMonto(limite ? limite.monto : "");
          setEditando(true);
        }}
      >
        {limite ? "Editar" : "Definir"}
      </Button>
    </span>
  );
}

function SeccionMiembros(props: Readonly<{ familia: FamiliaLista; onInvalidar: () => void }>) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const activos = props.familia.miembros.filter((m) => m.estado);

  const añadir = useMutation(
    trpc.familias.addMember.mutationOptions({
      onSuccess: () => {
        toast.success("Miembro añadido");
        setEmail("");
        void queryClient.invalidateQueries();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const darBaja = useMutation(
    trpc.familias.removeMember.mutationOptions({
      onSuccess: () => {
        toast.success("Miembro dado de baja");
        void queryClient.invalidateQueries();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const hacerJefe = useMutation(
    trpc.familias.setJefe.mutationOptions({
      onSuccess: () => {
        toast.success("Jefe reasignado");
        void queryClient.invalidateQueries();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const añadirMiembro = (): void => {
    const correo = email.trim().toLowerCase();
    if (!correo) return;
    añadir.mutate({ familiaId: props.familia.id, email: correo });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          className="h-8 max-w-xs"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="correo del nuevo miembro"
        />
        <Button size="sm" disabled={añadir.isPending || !email.trim()} onClick={añadirMiembro}>
          {añadir.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            "Añadir miembro"
          )}
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-3 font-medium">Correo</th>
            <th className="py-1 pr-3 font-medium">Rol</th>
            <th className="py-1 font-medium">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {activos.map((miembro) => (
            <tr key={miembro.membresiaId} className="border-t">
              <td className="py-1.5 pr-3">{miembro.correo}</td>
              <td className="py-1.5 pr-3">
                {miembro.esJefe ? (
                  <span className="rounded-full border px-2 py-0.5 text-xs text-amber-600">
                    Jefe
                  </span>
                ) : (
                  <span className="text-muted-foreground">Miembro</span>
                )}
              </td>
              <td className="flex gap-1 py-1.5">
                {!miembro.esJefe && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={hacerJefe.isPending}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `¿Hacer jefe de "${props.familia.nombre}" a ${miembro.correo}?`,
                          )
                        )
                          return;
                        hacerJefe.mutate({
                          familiaId: props.familia.id,
                          usuarioId: miembro.usuarioId,
                          version: props.familia.version,
                        });
                      }}
                    >
                      Hacer jefe
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={darBaja.isPending}
                      onClick={() => {
                        if (!window.confirm(`¿Dar de baja a ${miembro.correo}?`)) return;
                        darBaja.mutate({
                          membresiaId: miembro.membresiaId,
                          version: miembro.version,
                        });
                      }}
                    >
                      Dar de baja
                    </Button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {activos.length === 0 && (
            <tr>
              <td colSpan={3} className="py-2 text-muted-foreground">
                Sin miembros activos.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SeccionMiembrosInactivos(
  props: Readonly<{
    familia: FamiliaLista;
    onInvalidar: () => void;
  }>,
) {
  const queryClient = useQueryClient();
  const restaurar = useMutation(
    trpc.familias.restoreMember.mutationOptions({
      onSuccess: () => {
        toast.success("Miembro restaurado");
        void queryClient.invalidateQueries();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const inactivos = props.familia.miembros.filter((m) => !m.estado);
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">Miembros dados de baja</h3>
      <ul className="space-y-1">
        {inactivos.map((miembro) => (
          <li
            key={miembro.membresiaId}
            className="flex items-center justify-between gap-2 rounded-md border p-2"
          >
            <span className="text-sm">{miembro.correo}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={restaurar.isPending}
              onClick={() =>
                restaurar.mutate({ membresiaId: miembro.membresiaId, version: miembro.version })
              }
            >
              Restaurar
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
