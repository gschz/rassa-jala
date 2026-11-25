import { cn } from "@rassa-jala/ui/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: Readonly<{
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}>) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="space-y-1">
        <h1 className="text-page font-semibold tracking-tight">{title}</h1>
        {description != null && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions != null && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageContainer({
  className,
  children,
}: Readonly<{
  className?: string;
  children: React.ReactNode;
}>) {
  return (
    <div
      className={cn(
        // Left-aligned to the sidebar edge (one shared column with the header
        // title): no max-w/mx-auto dead margins on wide screens (fix 1).
        "flex w-full flex-col gap-4 px-4 py-4 md:py-6",
        className,
      )}
    >
      {children}
    </div>
  );
}
