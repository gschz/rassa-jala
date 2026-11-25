import { Button } from "@rassa-jala/ui/components/button";
import { cn } from "@rassa-jala/ui/lib/utils";
import { TriangleAlert } from "lucide-react";

export function ErrorState({
  title,
  description,
  onRetry,
  className,
}: Readonly<{
  title: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}>) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center",
        className,
      )}
    >
      <TriangleAlert className="size-5 text-destructive" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {onRetry != null && (
        <Button variant="outline" onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}
