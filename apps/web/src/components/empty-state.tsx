import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@rassa-jala/ui/components/empty";

export function EmptyState({
  title,
  description,
  icon,
  children,
}: Readonly<{
  title: string;
  description?: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}>) {
  return (
    <Empty className="rounded-lg border">
      <EmptyHeader>
        {icon != null && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle>{title}</EmptyTitle>
        {description != null && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children != null && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
