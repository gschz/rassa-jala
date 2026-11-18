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
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { refreshSession } from "@/lib/auth/http";
import { getAccessToken, getSession, setSession, useSession } from "@/lib/auth/session";
import { trpc } from "@/utils/trpc";

/**
 * P0 Usuarios — Q-07 forced password change gate (allowlisted against the server's
 * protectedProcedure gate). The page is only reachable while the session carries
 * debeCambiarPassword; __root.tsx redirects every other route here until the change
 * clears the flag.
 */
export const Route = createFileRoute("/cambiar-password")({
  beforeLoad: async () => {
    if (!getAccessToken() && !(await refreshSession())) {
      throw redirect({ to: "/login" });
    }
    // Nothing to change (flag already cleared) → normal navigation.
    if (!getSession().user?.debeCambiarPassword) throw redirect({ to: "/" });
  },
  component: CambiarPasswordRoute,
});

function CambiarPasswordRoute() {
  const session = useSession();
  const navigate = useNavigate();
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");

  const cambiar = useMutation(
    trpc.auth.changePassword.mutationOptions({
      onSuccess: () => {
        // The server cleared debe_cambiar_password and revoked every refresh session
        // (defensive default): the in-memory access token stays valid for this tab.
        if (session.user && getAccessToken()) {
          setSession({ ...session.user, debeCambiarPassword: false }, getAccessToken()!);
        }
        toast.success("Contraseña actualizada");
        void navigate({ to: "/" });
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
    <div className="flex h-full items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Cambiar contraseña
            <span className="rounded-full border px-2 py-0.5 text-xs font-normal text-amber-600">
              Debe cambiar su contraseña
            </span>
          </CardTitle>
          <CardDescription>
            Tu cuenta recibió una contraseña provisional. Define una nueva para continuar; no podrás
            navegar hasta completarlo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={enviar} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cambio-actual">Contraseña actual</Label>
              <Input
                id="cambio-actual"
                type="password"
                autoComplete="current-password"
                value={actual}
                onChange={(event) => setActual(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cambio-nueva">Nueva contraseña</Label>
              <Input
                id="cambio-nueva"
                type="password"
                autoComplete="new-password"
                value={nueva}
                onChange={(event) => setNueva(event.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={cambiar.isPending}>
              {cambiar.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                "Guardar y continuar"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
