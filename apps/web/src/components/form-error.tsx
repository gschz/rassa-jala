import { cn } from "@rassa-jala/ui/lib/utils";
import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

/** Inline form-level error, rendered next to the form/field (design doc §10). */
export function FormError({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
  if (children == null || children === "") return null;
  return (
    <p role="alert" className={cn("flex items-center gap-1.5 text-xs text-destructive", className)}>
      <AlertCircle className="size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}
