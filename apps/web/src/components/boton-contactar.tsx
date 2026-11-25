import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";

import { Button } from "@rassa-jala/ui/components/button";

import { useOnline } from "@/hooks/use-online";
import { trpc } from "@/utils/trpc";
import { notificarError } from "@/lib/notificar-error";

/**
 * T17 "Contactar" entry point (roadmap gap 21 → resolved / PDF M9): opens — get-or-
 * create, IDEMPOTENT — a 1:1 chat with the target user and navigates to /chat with
 * that conversation pre-selected (?conv=). The who-with-whom rules (Admin with
 * anyone; the rest only with Agricultor/Vendedor; nobody with a Cliente but Admin)
 * are enforced SERVER-side in chat.iniciarPrivado; this button only surfaces the
 * rejection toast. Requires connection (the mutation is online-only).
 */
export function BotonContactar({ fkUsuario }: Readonly<{ fkUsuario: string }>) {
  const isOnline = useOnline();
  const navigate = useNavigate();
  const iniciar = useMutation(
    trpc.chat.iniciarPrivado.mutationOptions({
      onSuccess: (r) => void navigate({ to: "/chat", search: { conv: r.idConversacion } }),
      onError: (error) => notificarError(error),
    }),
  );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!isOnline || iniciar.isPending}
      onClick={() => iniciar.mutate({ fkUsuario })}
    >
      <MessageSquare data-icon="inline-start" />
      Contactar
    </Button>
  );
}
