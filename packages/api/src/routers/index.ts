import { publicProcedure, router } from "../index";
import { authRouter } from "./auth";
import { catalogosRouter } from "./catalogos";
import { familiasRouter } from "./familias";
import { syncRouter } from "./sync";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  auth: authRouter,
  sync: syncRouter,
  catalogos: catalogosRouter,
  familias: familiasRouter,
});
export type AppRouter = typeof appRouter;
