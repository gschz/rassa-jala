import { Button } from "@rassa-jala/ui/components/button";
import { Separator } from "@rassa-jala/ui/components/separator";
import { useRouterState } from "@tanstack/react-router";
import { ChevronRight, Menu } from "lucide-react";

import { ModeToggle } from "@/components/mode-toggle";
import { SyncIndicator } from "@/components/sync-indicator";
import { breadcrumbDeRuta } from "@/components/navigation";
import { UserMenu } from "@/components/user-menu";
import { useSession } from "@/lib/auth/session";

/**
 * Authenticated top bar (doc §6): 64px breadcrumb (sidebar group / current view,
 * single-sourced from navigation.ts), compact sync indicator, theme toggle and
 * the user menu. Mobile keeps a compact row with the hamburger that opens the
 * navigation Sheet.
 */
export function AppHeader({ onOpenMobileNav }: Readonly<{ onOpenMobileNav: () => void }>) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const session = useSession();
  const ruta = breadcrumbDeRuta(pathname, session.user?.rol);

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onOpenMobileNav}
        aria-label="Abrir navegación"
      >
        <Menu />
      </Button>
      <nav
        aria-label="Ubicación actual"
        className="flex min-w-0 items-center gap-1.5 text-sm font-semibold tracking-tight"
      >
        {ruta.grupo != null && (
          <>
            <span className="min-w-0 truncate font-normal text-muted-foreground">{ruta.grupo}</span>
            <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="min-w-0 truncate">{ruta.vista}</span>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <SyncIndicator />
        <Separator orientation="vertical" className="max-md:hidden h-9" />
        <ModeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
