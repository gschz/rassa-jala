import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import { sessionExpired, useSession } from "@/lib/auth/session";
import { trpc } from "@/utils/trpc";

import { Button } from "@rassa-jala/ui/components/button";
import { ModeToggle } from "./mode-toggle";
/** Session identity + real server-side logout (P0 Autenticación). */
function Sesion() {
  const session = useSession();
  const navigate = useNavigate();
  const logout = useMutation(
    trpc.auth.logout.mutationOptions({
      onSettled: () => {
        // The server revoked the refresh token; drop the in-memory session and leave.
        sessionExpired();
        void navigate({ to: "/login" });
      },
    }),
  );
  if (!session.user) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{session.user.email}</span>
      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
        {session.user.rol}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
      >
        Salir
      </Button>
    </div>
  );
}

export default function Header() {
  const session = useSession();
  // P0 Catálogos: the admin CRUD surface is hidden from non-admin roles.
  // P0 Usuarios: /perfil for everyone, /usuarios for Admin only.
  // P0 Productos (Q-19): /productos is Admin-only CRUD.
  // P0 Publicaciones: /publicaciones for Agricultor/Admin; /catalogo for every role.
  // P0 Pedidos: /mis-pedidos for Cliente/Vendedor; /pedidos-vendedor for Vendedor;
  // /pedidos-admin for Admin.
  const esGestorPublicaciones = session.user?.rol === "Agricultor" || session.user?.rol === "Admin";
  const esVendedor = session.user?.rol === "Vendedor";
  const links = [
    { to: "/", label: "Catálogos" },
    { to: "/catalogo", label: "Catálogo" as const },
    { to: "/perfil", label: "Perfil" as const },
    ...(session.user?.rol === "Cliente" || esVendedor
      ? [{ to: "/mis-pedidos", label: "Mis pedidos" as const }]
      : []),
    ...(esVendedor ? [{ to: "/pedidos-vendedor", label: "Vendedor" as const }] : []),
    ...(esGestorPublicaciones ? [{ to: "/publicaciones", label: "Publicaciones" as const }] : []),
    ...(session.user?.rol === "Admin"
      ? [
          { to: "/catalogos", label: "Administración" as const },
          { to: "/productos", label: "Productos" as const },
          { to: "/familias", label: "Familias" as const },
          { to: "/usuarios", label: "Usuarios" as const },
          { to: "/pedidos-admin", label: "Pedidos" as const },
        ]
      : []),
  ] as const;

  return (
    <div>
      <div className="flex flex-row items-center justify-between px-2 py-1">
        <nav className="flex gap-4 text-lg">
          {links.map(({ to, label }) => {
            return (
              <Link key={to} to={to}>
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <Sesion />
          <ModeToggle />
        </div>
      </div>
      <hr />
    </div>
  );
}
