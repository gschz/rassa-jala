import { Button } from "@rassa-jala/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rassa-jala/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Printer, X } from "lucide-react";

import { trpc } from "@/utils/trpc";

interface ReciboDatos {
  folioRecibo: string;
  folioPago: string;
  tipoPago: string;
  referencia: string | null;
  monto: string;
  subtotal: string;
  iva: string;
  pedidoId: string;
  origen: string;
  notas: string | null;
  cliente: {
    id?: string;
    correo?: string;
    nombre: string | null;
    telefono?: string | null;
  } | null;
  vendedor: {
    id: string;
    correo: string;
    nombre: string | null;
  } | null;
  items: Array<{
    id: string;
    fkProductoSemanal: string;
    nombreProducto: string;
    cantidad: number;
    precioUnitario: string;
    importe: string;
  }>;
  emitidoEn: string;
}

export function ReciboModal({
  pedidoId,
  onClose,
}: Readonly<{
  pedidoId: string;
  onClose: () => void;
}>) {
  const reciboQuery = useQuery(trpc.pagos.obtenerRecibo.queryOptions({ fkPedido: pedidoId }));

  const imprimir = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:p-0">
      <Card className="max-h-[90vh] w-full max-w-lg overflow-y-auto bg-background print:max-h-none print:w-full print:border-none print:shadow-none">
        <CardHeader className="flex flex-row items-start justify-between pb-2">
          <div>
            <CardTitle className="text-xl">Comprobante de Pago</CardTitle>
            <CardDescription>Rassa Jala — Recibo Oficial</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="print:hidden">
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {reciboQuery.isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : reciboQuery.error ? (
            <p className="py-4 text-center text-sm text-red-500">
              {reciboQuery.error.message || "No se pudo cargar el recibo"}
            </p>
          ) : reciboQuery.data ? (
            (() => {
              const datos = reciboQuery.data.recibo.datos as unknown as ReciboDatos;
              const { pago } = reciboQuery.data;
              return (
                <div className="space-y-4">
                  <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Folio de Recibo:</span>
                      <span className="font-mono font-semibold">{datos.folioRecibo}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Folio de Pago:</span>
                      <span className="font-mono font-medium">{pago.folio}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Fecha de emisión:</span>
                      <span>{new Date(datos.emitidoEn).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Método de pago:</span>
                      <span className="font-medium">{pago.tipoPago}</span>
                    </div>
                    {pago.referencia && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Referencia:</span>
                        <span className="font-mono text-xs">{pago.referencia}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1 border-t pt-2">
                    <p className="font-medium text-xs text-muted-foreground uppercase tracking-wider">
                      Información de las partes
                    </p>
                    <p className="text-sm">
                      <span className="font-medium">Cliente:</span>{" "}
                      {datos.cliente?.nombre ?? datos.cliente?.correo ?? "Cliente físico"}
                      {datos.cliente?.telefono ? ` (${datos.cliente.telefono})` : ""}
                    </p>
                    {datos.vendedor && (
                      <p className="text-sm">
                        <span className="font-medium">Vendedor:</span>{" "}
                        {datos.vendedor.nombre ?? datos.vendedor.correo}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1 border-t pt-2">
                    <p className="font-medium text-xs text-muted-foreground uppercase tracking-wider">
                      Detalle de artículos
                    </p>
                    <div className="divide-y text-xs">
                      {datos.items.map((item) => (
                        <div key={item.id} className="flex justify-between py-1.5">
                          <span>
                            {item.cantidad} × {item.nombreProducto}{" "}
                            <span className="text-muted-foreground">
                              (${item.precioUnitario} c/u)
                            </span>
                          </span>
                          <span className="font-medium">${item.importe}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1 border-t pt-2 text-right">
                    <div className="flex justify-between text-muted-foreground text-xs">
                      <span>Subtotal</span>
                      <span>${datos.subtotal}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground text-xs">
                      <span>IVA (16%)</span>
                      <span>${datos.iva}</span>
                    </div>
                    <div className="flex justify-between font-semibold text-base pt-1 border-t">
                      <span>Total Pagado</span>
                      <span className="text-emerald-600">${datos.monto}</span>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2 border-t print:hidden">
                    <Button variant="outline" size="sm" onClick={imprimir}>
                      <Printer className="mr-1.5 h-4 w-4" /> Imprimir
                    </Button>
                    <Button size="sm" onClick={onClose}>
                      Cerrar
                    </Button>
                  </div>
                </div>
              );
            })()
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
