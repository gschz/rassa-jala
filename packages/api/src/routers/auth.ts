import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { AuthRuntime, CookieStore, Role } from "../context";
import {
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../auth";
import type { Database } from "@rassa-jala/db";
import { protectedProcedure, publicProcedure, router } from "../index";

type UsuarioConRol = {
  id: string;
  correo: string;
  estado: boolean;
  passwordHash: string;
  debeCambiarPassword: boolean;
  rol: { nombre: string };
};

type SesionInput = { db: Database; cookies: CookieStore; auth: AuthRuntime };

const credencialesSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

// Issues a fresh session pair: opaque refresh token (hashed row + httpOnly cookie) and a
// signed access JWT. Used by login and by refresh (rotation issues a full new pair).
// The session payload carries debeCambiarPassword (Q-07) so any client establishment
// path (login or silent refresh) can drive the forced-change redirect.
async function crearSesion(
  ctx: SesionInput,
  usuario: Pick<UsuarioConRol, "id" | "correo" | "debeCambiarPassword"> & {
    rol: { nombre: string };
  },
): Promise<{
  accessToken: string;
  user: { id: string; email: string; rol: Role; debeCambiarPassword: boolean };
}> {
  const user = {
    id: usuario.id,
    email: usuario.correo,
    rol: usuario.rol.nombre as Role,
    debeCambiarPassword: usuario.debeCambiarPassword,
  };
  const accessToken = await signAccessToken(user, ctx.auth.accessSecret);
  const refreshToken = generateRefreshToken();
  await ctx.db.refreshToken.create({
    data: {
      fkUsuario: usuario.id,
      tokenHash: hashRefreshToken(refreshToken, ctx.auth.refreshSecret),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  });
  ctx.cookies.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: "Lax",
    secure: ctx.auth.secureCookies,
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
  return { accessToken, user };
}

function revocarSesiones(ctx: SesionInput, idUsuario: string): Promise<unknown> {
  return ctx.db.refreshToken.updateMany({
    where: { fkUsuario: idUsuario, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export const authRouter = router({
  // F-01 fix: a deactivated usuario (estado=false) is rejected BEFORE any token is
  // issued, with an explicit message; wrong credentials get a generic message.
  login: publicProcedure.input(credencialesSchema).mutation(async ({ input, ctx }) => {
    const correo = input.email.trim().toLowerCase();
    const usuario = await ctx.db.usuario.findUnique({
      where: { correo },
      include: { rol: true },
    });
    if (!usuario || !(await Bun.password.verify(input.password, usuario.passwordHash))) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Credenciales inválidas" });
    }
    if (!usuario.estado) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Usuario desactivado" });
    }
    return crearSesion(ctx, usuario);
  }),

  // Rotation with real revocation (F-02 fix). Reuse of an already-rotated token is
  // treated as theft: the user's ENTIRE session family is revoked.
  refresh: publicProcedure.mutation(async ({ ctx }) => {
    const raw = ctx.cookies.get(REFRESH_COOKIE);
    if (!raw) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Sin sesión activa" });
    }
    const fila = await ctx.db.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(raw, ctx.auth.refreshSecret) },
      include: { usuario: { include: { rol: true } } },
    });
    if (!fila) {
      ctx.cookies.delete(REFRESH_COOKIE);
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Sesión inválida" });
    }
    if (fila.revokedAt) {
      await revocarSesiones(ctx, fila.fkUsuario);
      ctx.cookies.delete(REFRESH_COOKIE);
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Sesión revocada por seguridad" });
    }
    if (fila.expiresAt <= new Date()) {
      ctx.cookies.delete(REFRESH_COOKIE);
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Sesión expirada" });
    }
    // Uniform deactivated rule (F-01 implication): a deactivated usuario cannot renew.
    if (!fila.usuario.estado) {
      await revocarSesiones(ctx, fila.fkUsuario);
      ctx.cookies.delete(REFRESH_COOKIE);
      throw new TRPCError({ code: "FORBIDDEN", message: "Usuario desactivado" });
    }
    await ctx.db.refreshToken.update({
      where: { id: fila.id },
      data: { revokedAt: new Date() },
    });
    return crearSesion(ctx, fila.usuario);
  }),

  // Real server-side logout (F-03 fix): the presented refresh token is revoked.
  logout: publicProcedure.mutation(async ({ ctx }) => {
    const raw = ctx.cookies.get(REFRESH_COOKIE);
    if (raw) {
      await ctx.db.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(raw, ctx.auth.refreshSecret), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    // Idempotent: clearing the cookie is always safe.
    ctx.cookies.delete(REFRESH_COOKIE);
    return { ok: true };
  }),

  me: protectedProcedure.query(async ({ ctx }) => {
    const usuario = await ctx.db.usuario.findUnique({
      where: { id: ctx.user.id },
      include: { rol: true, persona: true },
    });
    if (!usuario?.estado) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "No autenticado" });
    }
    return {
      id: usuario.id,
      email: usuario.correo,
      rol: usuario.rol.nombre,
      estado: usuario.estado,
      debeCambiarPassword: usuario.debeCambiarPassword,
      persona: {
        nombre: usuario.persona.nombre,
        apellidoPaterno: usuario.persona.apellidoPaterno,
        apellidoMaterno: usuario.persona.apellidoMaterno,
        fkLocalidad: usuario.persona.fkLocalidad,
      },
    };
  }),

  // Change-password: legacy keeps access tokens valid until expiry; here the defensive
  // default is to close every refresh session, forcing a fresh login everywhere.
  changePassword: protectedProcedure
    .input(changePasswordSchema)
    .mutation(async ({ ctx, input }) => {
      const usuario = await ctx.db.usuario.findUnique({ where: { id: ctx.user.id } });
      if (!usuario) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "No autenticado" });
      }
      if (!(await Bun.password.verify(input.currentPassword, usuario.passwordHash))) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "La contraseña actual es incorrecta",
        });
      }
      const passwordHash = await Bun.password.hash(input.newPassword, { algorithm: "argon2id" });
      // Clearing the Q-07 flag releases the protectedProcedure forced-change gate; the
      // session revocation below still forces a fresh login on every device.
      await ctx.db.usuario.update({
        where: { id: usuario.id },
        data: { passwordHash, debeCambiarPassword: false },
      });
      await revocarSesiones(ctx, usuario.id);
      ctx.cookies.delete(REFRESH_COOKIE);
      return { ok: true };
    }),
});
