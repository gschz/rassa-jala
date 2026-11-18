import { TRPCError, initTRPC } from "@trpc/server";

import type { Context, Role } from "./context";

export const t = initTRPC.context<Context>().create();

export const router = t.router;

export const publicProcedure = t.procedure;

// Guard for every protected resolver: the transport verified the Bearer access JWT into
// ctx.user (null = absent/invalid/expired). The narrowed context downstream carries a
// non-null user. F-01 extension: the JWT stays valid until expiry even after the usuario
// row is deactivated, so every protected call re-verifies usuario.estado (single indexed
// PK lookup); login/refresh keep their own F-01 checks.
//
// Q-07 forced-change gate (single place for the whole API): while
// usuario.debeCambiarPassword is true, only the session/password procedures pass —
// everything else gets 403 until auth.changePassword clears the flag. opts.path is the
// tRPC procedure path (e.g. "auth.me").
const PROCEDIMIENTOS_CAMBIO_PERMITIDOS = new Set(["auth.changePassword", "auth.me", "auth.logout"]);

export const protectedProcedure = t.procedure.use(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "No autenticado" });
  }
  const usuario = await ctx.db.usuario.findUnique({
    where: { id: ctx.user.id },
    select: {
      estado: true,
      debeCambiarPassword: true,
      rol: { select: { nombre: true } },
    },
  });
  if (!usuario?.estado) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Usuario desactivado" });
  }
  if (usuario.debeCambiarPassword && !PROCEDIMIENTOS_CAMBIO_PERMITIDOS.has(opts.path)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Debe cambiar su contraseña antes de continuar",
    });
  }
  // F-26 freshness: the JWT role claim may be stale after changeRol (≤15 min
  // window). Role checks must read the DB role, not the claim — overwrite the
  // context user role on every protected call.
  return next({ ctx: { ...ctx, user: { ...ctx.user, rol: usuario.rol.nombre as Role } } });
});
