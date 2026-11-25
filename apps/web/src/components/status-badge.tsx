import { Badge } from "@rassa-jala/ui/components/badge";

/**
 * Status semantics on top of Badge — one mapping for every module list
 * (doc §10: states shown with badges). Tones come from semantic tokens.
 */
const TONO_VARIANTE = {
  ok: "success",
  pending: "warning",
  error: "destructive",
  info: "info",
  neutral: "secondary",
} as const;

export type StatusTone = keyof typeof TONO_VARIANTE;

export function StatusBadge({
  tone,
  children,
  className,
}: Readonly<{
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}>) {
  return (
    <Badge variant={TONO_VARIANTE[tone]} className={className}>
      {children}
    </Badge>
  );
}
