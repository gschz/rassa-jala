import { publicProcedure, router } from "../index";
import { authRouter } from "./auth";
import { syncRouter } from "./sync";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  auth: authRouter,
  sync: syncRouter,
});
export type AppRouter = typeof appRouter;
