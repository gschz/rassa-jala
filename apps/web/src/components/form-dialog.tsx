import { Button } from "@rassa-jala/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rassa-jala/ui/components/dialog";
import { Loader2 } from "lucide-react";
import { type ReactNode, type SubmitEvent } from "react";

/**
 * Modal create/edit form shell (gap-pass-4 Fase B): the same dialog serves the
 * create and edit modes instead of an inline form card. The caller renders the
 * fields as children and owns the validation/submit logic; server errors are
 * surfaced by the caller's FormError and must NOT close the dialog — only a
 * confirmed save (or an explicit cancel / Escape / backdrop click) closes it.
 */
export function FormDialog({
  open,
  onOpenChange,
  titulo,
  descripcion,
  guardando,
  puedeGuardar,
  etiquetaGuardar,
  onSubmit,
  children,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titulo: string;
  descripcion: string;
  guardando: boolean;
  puedeGuardar: boolean;
  etiquetaGuardar: string;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  children: ReactNode;
}>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
          <DialogDescription>{descripcion}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!puedeGuardar || guardando}>
              {guardando ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                etiquetaGuardar
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
