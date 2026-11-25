import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import { ADMIN, DEV_PASSWORD, ensureServer, login, must, sufijo, trpc } from "./helpers";

const T = 120_000;

type Creado = {
  id: string;
  correo: string;
  rol: string;
  debeCambiarPassword: boolean;
  passwordInicial?: string;
};

describe("role freshness e2e (p0-usuarios T3)", () => {
  let adminToken = "";

  beforeAll(async () => {
    await ensureServer();
    adminToken = (await login(ADMIN, DEV_PASSWORD)).token;
  }, 60_000);

  test(
    "downgraded admin token is rejected immediately with role-freshness 403",
    async () => {
      const correo = `fresh-admin-${sufijo()}@e2e.local`;
      const creado = await must<Creado>(
        "mutation",
        "usuarios.create",
        {
          email: correo,
          generate: true,
          rol: "Admin",
          nombre: "Admin",
          apellidoPaterno: "Fresco",
        },
        adminToken,
      );

      const ses = await login(correo, creado.passwordInicial!);
      await must(
        "mutation",
        "auth.changePassword",
        {
          currentPassword: creado.passwordInicial!,
          newPassword: "NuevoAdmin123",
        },
        ses.token,
      );

      // Seed admin downgrades the fresh admin while its access token is still valid.
      await must<{ ok: true }>(
        "mutation",
        "usuarios.changeRol",
        { id: creado.id, rol: "Cliente" },
        adminToken,
      );

      // The stale token must NOT authorize an Admin-only operation.
      const res = await trpc(
        "mutation",
        "catalogos.categoriasCreate",
        { nombre: `Fresh ${sufijo()}` },
        ses.token,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(403);
        expect(res.errorMessage).toBe("Solo el rol Admin puede modificar los catálogos");
      }
    },
    T,
  );
});
