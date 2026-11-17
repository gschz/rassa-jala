import { TRPCError, initTRPC } from "@trpc/server";

import type { Context } from "./context";

export const t = initTRPC.context<Context>().create();

export const router = t.router;

export const publicProcedure = t.procedure;

// Guard for every protected resolver: the transport verified the Bearer access JWT into
// ctx.user (null = absent/invalid/expired). The narrowed context downstream carries a
// non-null user. F-01 extension: the JWT stays valid until expiry even after the usuario
// row is deactivated, so every protected call re-verifies usuario.estado (single indexed
// PK lookup); login/refresh keep their own F-01 checks.
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "No autenticado" });
  }
  const usuario = await ctx.db.usuario.findUnique({
    where: { id: ctx.user.id },
    select: { estado: true },
  });
  if (!usuario?.estado) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Usuario desactivado" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
