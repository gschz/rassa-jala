import type { AppRouter } from "@rassa-jala/api/routers/index";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { toast } from "sonner";

import { ENV } from "../env";
import { authFetch } from "@/lib/auth/http";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      // Session expiry is handled by authFetch (silent refresh + redirect); re-toasting
      // the raw 401 would only add noise.
      if (error instanceof TRPCClientError && error.data?.code === "UNAUTHORIZED") return;
      toast.error(error.message, {
        action: {
          label: "retry",
          onClick: () => {
            query.invalidate();
          },
        },
      });
    },
  }),
});

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${ENV.VITE_SERVER_URL.replace(/\/$/, "")}/trpc`,
      // P0 auth: Bearer access token + cookies on every call; the 401 auto-refresh is
      // centralized in authFetch.
      fetch: authFetch,
    }),
  ],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: trpcClient,
  queryClient,
});
