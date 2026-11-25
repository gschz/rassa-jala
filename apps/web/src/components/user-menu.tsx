import { Badge } from "@rassa-jala/ui/components/badge";
import { Button } from "@rassa-jala/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rassa-jala/ui/components/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useLogout } from "@/hooks/use-logout";
import { useSession } from "@/lib/auth/session";
import { Link } from "@tanstack/react-router";
import { LogOut, UserRound } from "lucide-react";
import { useState } from "react";

/** Identity + account actions (doc §6): user, role and real logout. */
export function UserMenu() {
  const session = useSession();
  const logout = useLogout();
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);
  if (!session.user) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              className="h-9 gap-2 px-3 text-xs"
              aria-label="Cuenta de usuario"
            />
          }
        >
          <UserRound className="size-4 text-muted-foreground" aria-hidden />
          <span className="hidden max-w-40 truncate text-xs sm:inline">{session.user.email}</span>
          <Badge variant="secondary" className="hidden md:inline-flex">
            {session.user.rol}
          </Badge>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 p-1.5 m-0.5">
          {/* GroupLabel REQUIRES a Menu.Group ancestor (Base UI contract) — unlabelled
              label crashes the menu with "MenuGroupContext is missing". */}
          <DropdownMenuGroup>
            <DropdownMenuLabel className="space-y-0.5">
              <p className="truncate text-xs font-medium text-foreground">{session.user.email}</p>
              <p className="text-xs font-normal">Rol: {session.user.rol}</p>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="mt-1" render={<Link to="/perfil" />}>
            Mi perfil
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirmLogoutOpen(true)}
            disabled={logout.isPending}
          >
            <LogOut aria-hidden />
            Cerrar sesión
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmLogoutOpen}
        onOpenChange={setConfirmLogoutOpen}
        title="¿Cerrar sesión?"
        description="¿Estás seguro de que deseas salir de tu cuenta? Tendrás que volver a ingresar tus credenciales para acceder."
        confirmLabel="Cerrar sesión"
        destructive
        onConfirm={() => logout.mutate()}
      />
    </>
  );
}
