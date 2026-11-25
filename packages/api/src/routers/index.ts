import { publicProcedure, router } from "../index";
import { authRouter } from "./auth";
import { catalogosRouter } from "./catalogos";
import { chatRouter } from "./chat";
import { cortesRouter } from "./cortes";
import { dashboardRouter } from "./dashboard";
import { familiasRouter } from "./familias";
import { historialesRouter } from "./historiales";
import { liquidacionesRouter } from "./liquidaciones";
import { logsRouter } from "./logs";
import { mermasRouter } from "./mermas";
import { pagosRouter } from "./pagos";
import { pedidosRouter } from "./pedidos";
import { productosRouter } from "./productos";
import { publicacionesRouter } from "./publicaciones";
import { recoleccionesRouter } from "./recolecciones";
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
  recolecciones: recoleccionesRouter,
  cortes: cortesRouter,
  liquidaciones: liquidacionesRouter,
  mermas: mermasRouter,
  logs: logsRouter,
  historiales: historialesRouter,
  chat: chatRouter,
  dashboard: dashboardRouter,
});
export type AppRouter = typeof appRouter;
