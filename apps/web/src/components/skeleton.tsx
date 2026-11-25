import { Card, CardContent } from "@rassa-jala/ui/components/card";
import { Skeleton } from "@rassa-jala/ui/components/skeleton";
import { cn } from "@rassa-jala/ui/lib/utils";

/**
 * Shared loading placeholders (gap-pass-8 T3): skeleton patterns shaped like the
 * real content they replace — table rows, order cards, metric cards. Use ONLY
 * for the initial load (TanStack `isPending`/`isLoading`, RxDB `loading`);
 * background refetches keep the previous data on screen.
 */

const WIDTHS = ["w-full", "w-4/5", "w-2/3", "w-3/4"] as const;

/** Bordered block with bar rows — mirrors the plain/list tables shape. */
export function SkeletonTable({
  rows = 5,
  className,
}: Readonly<{ rows?: number; className?: string }>) {
  return (
    <div className={cn("space-y-2.5 rounded-lg border p-3", className)} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", WIDTHS[i % WIDTHS.length])} />
      ))}
    </div>
  );
}

/** Stacked card-shaped placeholders — mirrors pedido/agenda card lists. */
export function SkeletonCards({
  count = 3,
  className,
}: Readonly<{ count?: number; className?: string }>) {
  return (
    <div className={cn("space-y-2", className)} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
            <div className="flex-1 space-y-2">
              <Skeleton className={cn("h-4", WIDTHS[i % WIDTHS.length])} />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-8 w-20 rounded-md" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Metric card grid — mirrors the dashboard GridMetricas/TarjetaMetrica shape. */
export function SkeletonMetrics({
  count = 5,
  className,
}: Readonly<{ count?: number; className?: string }>) {
  return (
    <div
      className={cn("grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5", className)}
      aria-busy="true"
    >
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="gap-2">
          <CardContent className="space-y-1 px-4">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-7 w-1/2" />
            {i === 0 && <Skeleton className="h-3 w-3/4" />}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
