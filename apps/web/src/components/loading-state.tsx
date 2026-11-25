import { cn } from "@rassa-jala/ui/lib/utils";
import { Loader2 } from "lucide-react";

export function LoadingState({
  message,
  className,
}: Readonly<{ message?: string; className?: string }>) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 p-6 text-muted-foreground",
        className,
      )}
    >
      <Loader2 className="size-5 animate-spin" aria-hidden />
      {message != null && <p className="text-xs">{message}</p>}
      <span className="sr-only">Cargando</span>
    </div>
  );
}
