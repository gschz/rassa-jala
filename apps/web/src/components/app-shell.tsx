import { Sheet, SheetContent, SheetTitle } from "@rassa-jala/ui/components/sheet";
import { TooltipProvider } from "@rassa-jala/ui/components/tooltip";
import { cn } from "@rassa-jala/ui/lib/utils";
import { Outlet } from "@tanstack/react-router";
import { useState } from "react";

import { AppHeader } from "@/components/app-header";
import { AppSidebar, type SidebarMode } from "@/components/app-sidebar";
import { useSession } from "@/lib/auth/session";

const SIDEBAR_KEY = "rassa-sidebar-collapsed";
const SIDEBAR_MODE_KEY = "rassa-sidebar-mode";

/**
 * Authenticated layout (doc §6): persistent desktop sidebar (248px,
 * collapsible to 72px), header with sync/theme/user, scrollable main area.
 * Mobile: sidebar via Sheet, compact header, no horizontal scroll.
 */
export function AppShell() {
  const session = useSession();
  const [openMobile, setOpenMobile] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_MODE_KEY);
      if (saved === "expanded" || saved === "collapsed" || saved === "hover") {
        return saved;
      }
      return localStorage.getItem(SIDEBAR_KEY) === "1" ? "collapsed" : "expanded";
    } catch {
      return "expanded";
    }
  });
  const [isHovered, setIsHovered] = useState(false);

  // Transient state between logout click and the /login redirect: render
  // the bare outlet so the header never crashes on a missing user.
  if (!session.user) return <Outlet />;

  const handleSetSidebarMode = (mode: SidebarMode): void => {
    setSidebarMode(mode);
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, mode);
      localStorage.setItem(SIDEBAR_KEY, mode === "collapsed" ? "1" : "0");
    } catch {
      // Private mode without storage: mode stays session-only.
    }
  };

  const toggleCollapsed = (): void => {
    handleSetSidebarMode(sidebarMode === "collapsed" ? "expanded" : "collapsed");
  };

  const effectiveCollapsed = sidebarMode === "collapsed" || (sidebarMode === "hover" && !isHovered);

  return (
    <TooltipProvider>
      <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
        {/* Desktop sidebar */}
        <aside
          onMouseEnter={() => {
            if (sidebarMode === "hover") setIsHovered(true);
          }}
          onMouseLeave={() => {
            if (sidebarMode === "hover") setIsHovered(false);
          }}
          className={cn(
            "group/sidebar hidden shrink-0 border-r border-sidebar-border transition-[width] duration-200 ease-in-out md:block",
            effectiveCollapsed ? "w-18" : "w-62",
          )}
        >
          <AppSidebar
            collapsed={effectiveCollapsed}
            sidebarMode={sidebarMode}
            onSetSidebarMode={handleSetSidebarMode}
            onToggleCollapsed={toggleCollapsed}
          />
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <AppHeader onOpenMobileNav={() => setOpenMobile(true)} />
          <main data-slot="page-container" className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>

        {/* Mobile navigation */}
        <Sheet open={openMobile} onOpenChange={setOpenMobile}>
          <SheetContent side="left" className="w-70 gap-0 p-0 sm:max-w-70">
            <SheetTitle className="sr-only">Navegación</SheetTitle>
            <AppSidebar collapsed={false} onNavigate={() => setOpenMobile(false)} />
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}
