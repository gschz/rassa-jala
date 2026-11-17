import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rassa-jala/ui/components/card";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { LoginForm } from "@/components/auth/login-form";
import { getAccessToken } from "@/lib/auth/session";
import { useLogin } from "@/lib/auth/use-login";

/**
 * P0 Autenticación — login. The server issues the access token (kept in memory) and the
 * httpOnly refresh cookie; error messages arrive in Spanish from the server and surface
 * as-is ("Credenciales inválidas", "Usuario desactivado" — the F-01 fix).
 */
export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    if (getAccessToken()) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const { email, password, error, isPending, setEmail, setPassword, handleSubmit } = useLogin();

  return (
    <div className="flex h-full items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Iniciar sesión</CardTitle>
          <CardDescription>Accede con tu cuenta de RassaJala.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm
            email={email}
            password={password}
            error={error}
            isPending={isPending}
            onEmailChange={setEmail}
            onPasswordChange={setPassword}
            onSubmit={handleSubmit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
