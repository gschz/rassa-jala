import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { Sprout } from "lucide-react";

import { LoginForm } from "@/components/auth/login-form";
import { getAccessToken } from "@/lib/auth/session";
import { useLogin } from "@/lib/auth/use-login";

/**
 * P0 Autenticación — login (design doc §7). Split desktop layout: identity
 * panel + form panel; compact brand header on mobile. The auth flow,
 * validations and error states are untouched — the server issues the access
 * token (kept in memory) and the httpOnly refresh cookie; error messages
 * arrive in Spanish from the server and surface as-is ("Credenciales
 * inválidas", "Usuario desactivado" — the F-01 fix).
 */
export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    if (getAccessToken()) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

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
          Catálogos, pedidos y recolecciones en un solo lugar, con soporte para trabajo sin
          conexión.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">Acceso exclusivo para cuentas registradas.</p>
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

function LoginPage() {
  const { email, password, error, isPending, setEmail, setPassword, handleSubmit } = useLogin();

  return (
    <div className="grid h-full md:grid-cols-2">
      <MarcaPanel />
      <div className="flex h-full flex-col items-center overflow-y-auto px-4 justify-center">
        <MarcaCompacta />
        <div className="w-full max-w-sm space-y-4 pb-10 md:pb-0">
          <div className="space-y-1.5">
            <h1 className="text-section font-semibold tracking-tight">Iniciar sesión</h1>
            <p className="text-sm text-muted-foreground">Accede con tu cuenta de RassaJala.</p>
          </div>
          <LoginForm
            email={email}
            password={password}
            error={error}
            isPending={isPending}
            onEmailChange={setEmail}
            onPasswordChange={setPassword}
            onSubmit={handleSubmit}
            className="space-y-3"
          />
          <p className="text-center text-sm text-muted-foreground">
            ¿No tienes cuenta?{" "}
            <Link to="/registro" className="underline">
              Regístrate
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
