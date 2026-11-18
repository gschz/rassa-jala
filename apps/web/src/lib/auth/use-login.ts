import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type SubmitEvent } from "react";

import { setSession } from "@/lib/auth/session";
import { trpc } from "@/utils/trpc";

export interface UseLoginOptions {
  onSuccessRedirectTo?: string;
}

export function useLogin(options?: UseLoginOptions) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loginMutation = useMutation(
    trpc.auth.login.mutationOptions({
      onSuccess: (res) => {
        setSession(res.user, res.accessToken);
        // Q-07: a forced password change parks the user on the gate page until cleared.
        void navigate({
          to: res.user.debeCambiarPassword
            ? "/cambiar-password"
            : (options?.onSuccessRedirectTo ?? "/"),
        });
      },
      onError: (err) => setError(err.message),
    }),
  );

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Ingresa tu correo y contraseña.");
      return;
    }

    loginMutation.mutate({ email: trimmedEmail, password });
  };

  return {
    email,
    setEmail,
    password,
    setPassword,
    error,
    setError,
    isPending: loginMutation.isPending,
    handleSubmit,
  };
}
