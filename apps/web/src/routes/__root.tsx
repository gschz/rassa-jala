import { Toaster } from "@rassa-jala/ui/components/sonner";
import type { QueryClient } from "@tanstack/react-query";
import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";

// import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
// import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { getSession, useSession } from "@/lib/auth/session";
import { breadcrumbDeRuta } from "@/components/navigation";
import type { trpc } from "@/utils/trpc";

import "../index.css";

export interface RouterAppContext {
  trpc: typeof trpc;
  queryClient: QueryClient;
}

/** Public chrome (doc §6): no admin navigation around the auth flows. */
const PUBLIC_PATHS = new Set(["/login", "/registro", "/cambiar-password"]);

export const Route = createRootRouteWithContext<RouterAppContext>()({
  // Q-07 forced-change gate (client side): while the session carries
  // debeCambiarPassword, every navigation lands on /cambiar-password until
  // auth.changePassword clears the flag. The server enforces the same rule per
  // procedure (protectedProcedure allowlist); this only shapes the UI flow.
  beforeLoad: ({ location }) => {
    const { user } = getSession();
    if (user?.debeCambiarPassword && location.pathname !== "/cambiar-password") {
      throw redirect({ to: "/cambiar-password" });
    }
  },
  errorComponent: ({ error }) => (
    <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
      <h2 className="text-xl font-bold tracking-tight text-foreground">Algo salió mal</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "Error inesperado al cargar la aplicación."}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Recargar página
      </button>
    </div>
  ),
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: "RASSA JALA",
      },
      {
        name: "description",
        content:
          "Red Agroecológica y Solidaria para la Soberanía Alimentaria — Juntos Alimentamos la Autonomía",
      },
    ],
    links: [
      {
        rel: "icon",
        href: "/favicon.ico",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon.png",
      },
    ],
  }),
});

function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const session = useSession();
  // PWA window title (and browser tab): "<vista>" without the brand — the
  // installed-app chrome prepends the manifest name itself ("Rassajala - Mi
  // perfil"); a static brand title duplicated it ("Rassajala - RASSA JALA").
  useEffect(() => {
    document.title = PUBLIC_PATHS.has(pathname)
      ? ({
          "/login": "Iniciar sesión",
          "/registro": "Crear cuenta",
          "/cambiar-password": "Cambiar contraseña",
        }[pathname] ?? "RassaJala")
      : breadcrumbDeRuta(pathname, session.user?.rol).vista;
  }, [pathname, session.user?.rol]);
  const publico = PUBLIC_PATHS.has(pathname);

  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        disableTransitionOnChange
        storageKey="vite-ui-theme"
      >
        {publico ? (
          // Public chrome: full-viewport auth flow, no sidebar/header.
          <div className="h-svh bg-background text-foreground">
            <Outlet />
          </div>
        ) : (
          // Authenticated chrome: sidebar + header + sync indicator.
          <AppShell />
        )}
        <Toaster richColors />
      </ThemeProvider>
      {/* <TanStackRouterDevtools position="bottom-left" />
      <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" /> */}
    </>
  );
}
