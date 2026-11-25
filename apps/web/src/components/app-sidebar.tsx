// import { Badge } from "@rassa-jala/ui/components/badge";
import { Button } from "@rassa-jala/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rassa-jala/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rassa-jala/ui/components/tooltip";
import { cn } from "@rassa-jala/ui/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { PanelLeft, PanelLeftClose, PanelLeftOpen, Sprout } from "lucide-react";

import { navParaRol, titulosDeSeccion } from "@/components/navigation";
import { useSession } from "@/lib/auth/session";

export type SidebarMode = "expanded" | "collapsed" | "hover";

/**
 * Grouped, role-filtered navigation (doc §6). Rendered collapsed (72px,
 * icons + tooltips) or expanded (248px) on desktop; full-width inside the
 * mobile Sheet. Section titles are hidden for roles with ≤5 links; the
 * footer carries only the sidebar-mode control — logout lives in the
 * header UserMenu (labeled item, no duplicated cramped icons).
 */
export function AppSidebar({
  collapsed,
  sidebarMode,
  onSetSidebarMode,
  onToggleCollapsed,
  onNavigate,
  className,
}: Readonly<{
  collapsed: boolean;
  sidebarMode?: SidebarMode;
  onSetSidebarMode?: (mode: SidebarMode) => void;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
  className?: string;
}>) {
  const session = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const grupos = navParaRol(session.user?.rol);
  const conTitulos = titulosDeSeccion(grupos);

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground", className)}
    >
      {/* Brand */}
      <div
        className={cn(
          "flex min-h-16 items-center gap-2 border-b border-sidebar-border px-3",
          collapsed ? "justify-center" : "gap-2.5",
        )}
      >
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
          aria-hidden
        >
          <Sprout className="size-5" />
        </span>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-tight">RassaJala</p>
            <p className="truncate text-xs text-muted-foreground">Comercio agrícola local</p>
          </div>
        )}
      </div>

      {/* Nav groups */}
      <nav aria-label="Navegación principal" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {grupos.map((group) => (
          <div key={group.heading ?? group.items[0].to} className="mb-1">
            {/* Untitled group (General) and ≤5-link roles render without a heading. */}
            {!collapsed && conTitulos && group.heading != null && (
              <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {group.heading}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const activo = pathname === item.to;
                const enlace = (
                  <Link
                    to={item.to}
                    // Blur on activate: after a route change the clicked link keeps
                    // :focus and the focus ring reads as a second "active border".
                    onClick={(event) => {
                      onNavigate?.();
                      event.currentTarget.blur();
                    }}
                    aria-current={activo ? "page" : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    className={cn(
                      "flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-sidebar-ring md:min-h-9",
                      collapsed && "justify-center px-0 md:min-h-11",
                      activo
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80",
                    )}
                  >
                    <item.icon className="size-4 shrink-0" aria-hidden />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                );
                return (
                  <li key={item.to}>
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger render={<span className="block" />}>
                          {enlace}
                        </TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    ) : (
                      enlace
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer: sidebar-mode control only, right-aligned. Logout lives in the
          header UserMenu (labeled item) — the cramped icon pair is gone. */}
      {(onSetSidebarMode != null || onToggleCollapsed != null) && (
        <div className="flex items-center justify-end border-t border-sidebar-border p-2">
          {onSetSidebarMode != null ? (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon" aria-label="Control de barra lateral">
                        <PanelLeft className="size-4" />
                      </Button>
                    }
                  />
                </TooltipTrigger>
                <TooltipContent side={collapsed ? "right" : "top"}>
                  Control de barra lateral
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align={collapsed ? "start" : "end"}
                side={collapsed ? "right" : "top"}
                className="w-56"
              >
                <DropdownMenuLabel>Control de barra lateral</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={sidebarMode}
                  onValueChange={(val) => onSetSidebarMode(val as SidebarMode)}
                >
                  <DropdownMenuRadioItem value="expanded">Expandido</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="collapsed">Colapsado</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="hover">
                    Expandir al pasar el cursor
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            onToggleCollapsed != null && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleCollapsed}
                aria-label={collapsed ? "Expandir panel" : "Colapsar panel"}
              >
                {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}
