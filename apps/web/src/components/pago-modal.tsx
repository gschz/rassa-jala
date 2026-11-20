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
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { useState, SubmitEvent } from "react";
import { toast } from "sonner";

import { useOnline } from "@/hooks/use-online";
import { trpc } from "@/utils/trpc";

export function PagoModal({
  pedidoId,
  total,
  onClose,
  onSuccess,
}: Readonly<{
  pedidoId: string;
  total: string;
  onClose: () => void;
  onSuccess: () => void;
}>) {
  const isOnline = useOnline();
  const [fkTipoPago, setFkTipoPago] = useState("");
  const [referencia, setReferencia] = useState("");

  const tiposPago = useQuery(trpc.pagos.tiposPago.queryOptions());

  const registrarPago = useMutation(
    trpc.pagos.registrarPago.mutationOptions({
      onSuccess: (data) => {
        toast.success(`Pago registrado exitosamente (Folio: ${data.folioPago})`);
        onSuccess();
        onClose();
      },
      onError: (error) => {
        toast.error(error.message || "Error al registrar pago");
      },
    }),
  );

  const handleSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!fkTipoPago) {
      toast.error("Selecciona un método de pago");
      return;
    }
    registrarPago.mutate({
      fkPedido: pedidoId,
      fkTipoPago,
      ...(referencia.trim() ? { referencia: referencia.trim() } : {}),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-md bg-background">
        <CardHeader className="flex flex-row items-start justify-between pb-2">
          <div>
            <CardTitle>Registrar Pago</CardTitle>
            <CardDescription>
              Pedido #{pedidoId.slice(0, 8)} · Total a cobrar:{" "}
              <span className="font-semibold text-emerald-600">${total}</span>
            </CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={registrarPago.isPending}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {!isOnline && (
            <p className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              Operación deshabilitada sin conexión. Conéctate a internet para registrar pagos.
            </p>
          )}
          <form onSubmit={handleSubmit} className="space-y-4 text-sm">
            <div className="space-y-1">
              <Label htmlFor="tipo-pago">Método de Pago</Label>
              {tiposPago.isLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Cargando métodos…
                </div>
              ) : (
                <select
                  id="tipo-pago"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={fkTipoPago}
                  onChange={(e) => setFkTipoPago(e.target.value)}
                  disabled={!isOnline || registrarPago.isPending}
                  required
                >
                  <option value="" disabled>
                    Selecciona un método…
                  </option>
                  {(tiposPago.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nombre}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="referencia">Referencia / Comprobante (opcional)</Label>
              <Input
                id="referencia"
                value={referencia}
                onChange={(e) => setReferencia(e.target.value)}
                placeholder="Número de transferencia, voucher, etc."
                disabled={!isOnline || registrarPago.isPending}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={registrarPago.isPending}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={!isOnline || !fkTipoPago || registrarPago.isPending}>
                {registrarPago.isPending ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Procesando…
                  </>
                ) : (
                  "Confirmar Pago"
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
