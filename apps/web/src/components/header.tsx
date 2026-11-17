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
  const links = [
    { to: "/", label: "Catálogos" },
    ...(session.user?.rol === "Admin"
      ? [{ to: "/catalogos", label: "Administración" as const }]
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
