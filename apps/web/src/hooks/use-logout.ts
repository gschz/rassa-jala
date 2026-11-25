import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { sessionExpired } from "@/lib/auth/session";
import { trpc } from "@/utils/trpc";

/**
 * Real server-side logout (P0 Autenticación) — shared by the header user
 * menu and the sidebar footer. Semantics copied verbatim from the legacy
 * header: the server revokes the refresh token, then the in-memory session
 * is dropped and the user leaves.
 */
export function useLogout() {
  const navigate = useNavigate();
  const logout = useMutation(
    trpc.auth.logout.mutationOptions({
      onSettled: () => {
        sessionExpired();
        void navigate({ to: "/login" });
      },
    }),
  );
  return logout;
}
