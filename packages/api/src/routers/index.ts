import { publicProcedure, router } from "../index";
import { syncRouter } from "./sync";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  sync: syncRouter,
});
export type AppRouter = typeof appRouter;
