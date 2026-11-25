import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import { ADMIN, CLIENTE, DEV_PASSWORD, ensureServer, login, trpc } from "./helpers";

const T = 240_000;

type FilaLog = {
  id: string;
  accion: string;
  entidad: string | null;
  entidadId: string | null;
  ip: string;
  dispositivo: string;
  detalle: unknown;
  creadoEn: string;
  usuario: { id: string; correo: string; nombre: string | null } | null;
};

type LogsList = {
  filas: FilaLog[];
  total: number;
  page: number;
  pageSize: number;
};

// M-7 bitácora (T11 gap-pass-7): every login attempt (success and failure) lands in the
// append-only `logs` table with ip/dispositivo; only Admin can read the trail. The tRPC
// context injects the client identity (X-Forwarded-For first hop, else the socket
// address; User-Agent as dispositivo), so the login row carries the TEST's own request
// identity — loopback IP (127.0.0.1) and Bun's default User-Agent — never the sentinel.
describe("logs e2e (M-7 bitácora proofs)", () => {
  let adminToken = "";
  let adminId = "";

  beforeAll(async () => {
    await ensureServer();
    // The login itself is the audited action under test (auth.login row).
    const ses = await login(ADMIN, DEV_PASSWORD);
    adminToken = ses.token;
    adminId = ses.user.id;
  }, T);

  test(
    "a login action generates a log row with ip/dispositivo attributed to the usuario",
    async () => {
      const res = await trpc<LogsList>(
        "query",
        "logs.list",
        { page: 1, pageSize: 50, usuarioId: adminId, accion: "auth.login" },
        adminToken,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.total).toBeGreaterThanOrEqual(1);
      expect(res.data.filas.every((f) => f.accion === "auth.login")).toBe(true);
      const propia = res.data.filas.find((f) => f.usuario?.id === adminId);
      expect(propia).toBeDefined();
      if (!propia) return;
      // Real request identity: the fixture fetches over loopback with Bun's default
      // User-Agent — the "unknown" sentinel only appears when detection fails.
      expect(propia.ip.length).toBeGreaterThan(0);
      expect(propia.ip).not.toBe("unknown");
      expect(propia.dispositivo.length).toBeGreaterThan(0);
      expect(propia.dispositivo).not.toBe("unknown");
      expect(propia.entidad).toBe("usuario");
    },
    T,
  );

  test(
    "a FAILED login (unknown password) logs login_fallido with a null usuario",
    async () => {
      const fallo = await trpc("mutation", "auth.login", {
        email: CLIENTE,
        password: "no-es-la-contrasena",
      });
      expect(fallo.ok).toBe(false);

      const res = await trpc<LogsList>(
        "query",
        "logs.list",
        { page: 1, pageSize: 50, accion: "auth.login_fallido" },
        adminToken,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.total).toBeGreaterThanOrEqual(1);
      const fila = res.data.filas.find((f) => f.usuario === null);
      expect(fila).toBeDefined();
    },
    T,
  );

  test(
    "the date-range filter narrows the list (hasta in the past → empty)",
    async () => {
      const res = await trpc<LogsList>(
        "query",
        "logs.list",
        { page: 1, pageSize: 50, hasta: "2000-01-01" },
        adminToken,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.total).toBe(0);
      expect(res.data.filas).toHaveLength(0);
    },
    T,
  );

  test(
    "logs.acciones returns the DISTINCT action vocabulary including auth.login",
    async () => {
      const res = await trpc<string[]>("query", "logs.acciones", {}, adminToken);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data).toContain("auth.login");
      // DISTINCT: no duplicates even with many logged rows.
      expect(new Set(res.data).size).toBe(res.data.length);
    },
    T,
  );

  test(
    "a non-Admin (Cliente) gets 403 FORBIDDEN on the bitácora",
    async () => {
      const clienteToken = (await login(CLIENTE, DEV_PASSWORD)).token;
      const res = await trpc<LogsList>(
        "query",
        "logs.list",
        { page: 1, pageSize: 50 },
        clienteToken,
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(403);
      expect(res.errorCode).toBe("FORBIDDEN");
      const acciones = await trpc<string[]>("query", "logs.acciones", {}, clienteToken);
      expect(acciones.ok).toBe(false);
      if (acciones.ok) return;
      expect(acciones.errorCode).toBe("FORBIDDEN");
    },
    T,
  );
});
