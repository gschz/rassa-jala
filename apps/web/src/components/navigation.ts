import {
  CalendarDays,
  ClipboardList,
  ClipboardCheck,
  Database,
  Home,
  Megaphone,
  MessageSquare,
  Package,
  PackageMinus,
  ScrollText,
  Store,
  Vault,
  Wallet,
  Boxes,
  Users,
  UserCog,
  type LucideIcon,
} from "lucide-react";

/**
 * Navigation model (doc §6): grouped by business flow, filtered by role.
 * Role sets are copied verbatim from the legacy header — they must match the
 * guards the routes already enforce, so no link can 403. Only the grouping,
 * order and labels changed; permissions are untouched.
 */
const TODOS_LOS_ROLES = ["Admin", "Vendedor", "Agricultor", "Cliente"] as const;

export const NAV_GROUPS: readonly NavGroup[] = [
  // General: always-on links — untitled group (rendered without a heading).
  {
    heading: null,
    items: [
      { to: "/", label: "Inicio", icon: Home, roles: TODOS_LOS_ROLES },
      // P1-D Chat (M-18): legacy IsAuthenticated — any member of a conversation reads/
      // writes; the page shows only the caller's integrantes-scoped conversations.
      { to: "/chat", label: "Chat", icon: MessageSquare, roles: TODOS_LOS_ROLES },
    ],
  },
  {
    heading: "Operación y ventas",
    items: [
      { to: "/catalogo", label: "Catálogo", icon: Store, roles: TODOS_LOS_ROLES },
      { to: "/mis-pedidos", label: "Mis pedidos", icon: Package, roles: ["Cliente", "Vendedor"] },
      { to: "/pedidos-admin", label: "Pedidos", icon: ClipboardCheck, roles: ["Admin"] },
      { to: "/pedidos-vendedor", label: "Vendedor", icon: ClipboardList, roles: ["Vendedor"] },
    ],
  },
  {
    heading: "Oferta y logística",
    items: [
      {
        to: "/publicaciones",
        label: "Publicaciones",
        icon: Megaphone,
        roles: ["Agricultor", "Admin"],
      },
      {
        to: "/recolecciones",
        label: "Recolecciones",
        icon: CalendarDays,
        roles: ["Vendedor", "Admin", "Agricultor"],
      },
      // P1-C Mermas (M-17): legacy HasRole(ADMIN, VENDEDOR) — the seller registers
      // losses on its own pedidos, the Admin on any; Agricultor/Cliente are 403.
      { to: "/mermas", label: "Mermas", icon: PackageMinus, roles: ["Admin", "Vendedor"] },
    ],
  },
  {
    heading: "Finanzas",
    items: [
      // P1-A Cortes (M-15): legacy IsAdminOrVendedor — the seller closes its own day,
      // the Admin sees all (its own create lane only, legacy parity).
      { to: "/cortes", label: "Cortes de caja", icon: Vault, roles: ["Vendedor", "Admin"] },
      // P1-B Liquidaciones (M-16): legacy HasRole(ADMIN) parity — the whole module
      // is Admin-only; the server 403s every other role.
      { to: "/liquidaciones", label: "Liquidaciones", icon: Wallet, roles: ["Admin"] },
    ],
  },
  {
    heading: "Catálogos y sistema",
    items: [
      { to: "/productos", label: "Productos", icon: Boxes, roles: ["Admin"] },
      { to: "/catalogos", label: "Municipios", icon: Database, roles: ["Admin"] },
      { to: "/familias", label: "Familias", icon: Users, roles: ["Admin"] },
      { to: "/usuarios", label: "Usuarios", icon: UserCog, roles: ["Admin"] },
      // M-7 bitácora de auditoría (backend-audit §2.6): Admin-only read-only listing.
      { to: "/logs", label: "Bitácora", icon: ScrollText, roles: ["Admin"] },
    ],
  },
];

/** Groups the session role is allowed to see; empty groups are dropped. */
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  roles: readonly string[];
}

export interface NavGroup {
  /** null = untitled group (General); rendered without a heading. */
  heading: string | null;
  items: readonly NavItem[];
}

export function navParaRol(rol: string | undefined): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: rol ? group.items.filter((item) => item.roles.includes(rol)) : [],
  })).filter((group) => group.items.length > 0);
}

/**
 * Section titles are hidden when the role ends with ≤5 links (Cliente,
 * Agricultor): the sidebar reads as a plain list for the small-role users.
 */
export function titulosDeSeccion(grupos: readonly NavGroup[]): boolean {
  const total = grupos.reduce((n, group) => n + group.items.length, 0);
  return total > 5;
}

/** Header breadcrumb line (route → group, single-sourced from NAV_GROUPS). */
export interface Breadcrumb {
  /** Sidebar group name; null = untitled group or compact role (titles hidden). */
  grupo: string | null;
  /** Current view label. */
  vista: string;
}

/** Authenticated views outside NAV_GROUPS (no sidebar entry) — label shown without a group. */
const RUTAS_FUERA_DE_NAV: Record<string, string> = {
  "/perfil": "Mi perfil",
};

/**
 * Contextual breadcrumb for the header, derived from the same NAV_GROUPS model:
 * `grupo / vista`. Compact roles (Cliente/Agricultor) hide the group exactly
 * like the sidebar does (titulosDeSeccion); they see the view name only.
 */
export function breadcrumbDeRuta(pathname: string, rol: string | undefined): Breadcrumb {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.to === pathname) {
        const conTitulos = titulosDeSeccion(navParaRol(rol));
        return { grupo: conTitulos ? group.heading : null, vista: item.label };
      }
    }
  }
  const fueraDeNav = RUTAS_FUERA_DE_NAV[pathname];
  if (fueraDeNav) return { grupo: null, vista: fueraDeNav };
  return { grupo: null, vista: "RassaJala" };
}
