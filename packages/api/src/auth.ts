import { createHmac } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

import type { ContextUser, Role } from "./context";

// Token/session lifetimes (backend-audit §2.2: access 15 min, refresh 7 days).
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

// The refresh cookie is scoped to the tRPC transport path: everything the clients send
// (batched or not) lives under /trpc, so page loads never carry the session cookie.
export const REFRESH_COOKIE = "rassa_refresh";
export const REFRESH_COOKIE_PATH = "/trpc";

const encoder = new TextEncoder();

export async function signAccessToken(user: ContextUser, secret: string): Promise<string> {
  return new SignJWT({ rol: user.rol, email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(encoder.encode(secret));
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<ContextUser | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), { algorithms: ["HS256"] });
    const { sub, rol, email } = payload;
    if (typeof sub !== "string" || typeof rol !== "string" || typeof email !== "string") {
      return null;
    }
    // Data-driven roles: the claim is trusted as the rol name (unknown names fail any
    // role comparison — deny by default), no enum check that would break new DB roles.
    return { id: sub, email, rol: rol as Role };
  } catch {
    return null;
  }
}

// Opaque 32-byte random refresh token; only a keyed digest is stored, so a database leak
// alone cannot mint valid tokens (JWT_REFRESH_SECRET is the pepper for HMAC-SHA256).
export function generateRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function hashRefreshToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}
