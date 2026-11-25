import { Alert, AlertDescription } from "@rassa-jala/ui/components/alert";
import { Button } from "@rassa-jala/ui/components/button";
import { Input } from "@rassa-jala/ui/components/input";
import { Label } from "@rassa-jala/ui/components/label";
import { PasswordInput } from "@rassa-jala/ui/components/password-input";
import { AlertCircle, Loader2 } from "lucide-react";
import type { SubmitEvent } from "react";

export interface LoginFormProps {
  email: string;
  password: string;
  error: string | null;
  isPending: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  className?: string;
}

export function LoginForm({
  email,
  password,
  error,
  isPending,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  className = "space-y-3",
}: Readonly<LoginFormProps>) {
  return (
    <form onSubmit={onSubmit} className={className}>
      <div className="space-y-1.5">
        <Label htmlFor="login-email">Correo electrónico</Label>
        <Input
          id="login-email"
          type="email"
          autoComplete="email"
          className="h-11"
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="correo@ejemplo.com"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="login-password">Contraseña</Label>
        <PasswordInput
          id="login-password"
          autoComplete="current-password"
          className="h-11"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
        />
      </div>
      {error != null && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={isPending} className="w-full h-10">
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Iniciar sesión"}
      </Button>
    </form>
  );
}
