import { publicProcedure, router } from "../index";
import { authRouter } from "./auth";
import { catalogosRouter } from "./catalogos";
import { familiasRouter } from "./familias";
import { pagosRouter } from "./pagos";
import { pedidosRouter } from "./pedidos";
import { productosRouter } from "./productos";
import { publicacionesRouter } from "./publicaciones";
import { syncRouter } from "./sync";
import { usuariosRouter } from "./usuarios";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  auth: authRouter,
  sync: syncRouter,
  catalogos: catalogosRouter,
  familias: familiasRouter,
  usuarios: usuariosRouter,
  productos: productosRouter,
  publicaciones: publicacionesRouter,
  pedidos: pedidosRouter,
  pagos: pagosRouter,
});
export type AppRouter = typeof appRouter;
