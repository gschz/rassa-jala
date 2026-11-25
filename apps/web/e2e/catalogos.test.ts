import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN,
  AGRO,
  DEV_PASSWORD,
  ensureServer,
  login,
  maxSeq,
  must,
  pgQuery,
  pullHasta,
  sufijo,
  tokenDe,
  trpc,
} from "./helpers";

const T = 240_000;

type CatalogoDto = {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  actualizadoEn: string;
};

type PullDoc = CatalogoDto & { _deleted: boolean };

describe("catalogos e2e (p0-catalogos proofs)", () => {
  let adminToken = "";
  let adminId = "";
  let agroToken = "";

  beforeAll(async () => {
    await ensureServer();
    const ses = await login(ADMIN, DEV_PASSWORD);
    adminToken = ses.token;
    adminId = ses.user.id;
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
  }, 90_000);

  test(
    "create lands the row (v1) + one outbox row in the SAME tx (M-1a)",
    async () => {
      const nombre = `QA Cat e2e ${sufijo()}`;
      const cp = await maxSeq("categoria_producto");
      const res = await trpc<CatalogoDto>(
        "mutation",
        "catalogos.categoriasCreate",
        { nombre },
        adminToken,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.nombre).toBe(nombre);
      expect(res.data.version).toBe(1);
      expect(res.data.estado).toBe(true);

      const outbox = await pgQuery<{ operacion: string; actor: string }>(
        "select operacion, actor from sync_cambio where tabla_origen = 'categoria_producto' and id_fila = $1",
        [res.data.id],
      );
      expect(outbox.length).toBe(1);
      expect(outbox[0]?.operacion).toBe("insert");
      expect(outbox[0]?.actor).toBe(adminId);
      expect(outbox[0]?.actor).not.toBe("dev-seed");

      // PULL propagation from the OLD checkpoint: the new doc arrives (gap-window tolerant).
      const docs = await pullHasta<PullDoc>("categorias", cp, adminToken, (ds) =>
        ds.some((d) => d.id === res.data.id),
      );
      const doc = docs.find((d) => d.id === res.data.id);
      expect(doc?.nombre).toBe(nombre);
      expect(doc?.version).toBe(1);
      expect(doc?._deleted).toBe(false);
    },
    T,
  );

  test(
    "update CAS: replayed version -> 409 with the server version in the message",
    async () => {
      const nombre = `QA Cat CAS e2e ${sufijo()}`;
      const creado = await must<CatalogoDto>(
        "mutation",
        "catalogos.categoriasCreate",
        { nombre },
        adminToken,
      );
      // Real update v1 → v2.
      const upd = await trpc<CatalogoDto>(
        "mutation",
        "catalogos.categoriasUpdate",
        { id: creado.id, version: 1, nombre: `${nombre} v2` },
        adminToken,
      );
      expect(upd.ok).toBe(true);
      if (!upd.ok) return;
      expect(upd.data.version).toBe(2);

      // Replayed v1 → 409 "Conflicto de versión ... (versión actual: 2, enviada: 1)".
      const replay = await trpc(
        "mutation",
        "catalogos.categoriasUpdate",
        { id: creado.id, version: 1, nombre: `${nombre} v3` },
        adminToken,
      );
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.status).toBe(409);
        expect(replay.errorMessage).toContain("Conflicto de versión");
        expect(replay.errorMessage).toContain("versión actual: 2");
        expect(replay.errorMessage).toContain("enviada: 1");
      }
    },
    T,
  );

  test(
    "setEstado soft-delete + restore bump the version and the outbox (v3/v4)",
    async () => {
      const nombre = `QA Cat Estado e2e ${sufijo()}`;
      const creado = await must<CatalogoDto>(
        "mutation",
        "catalogos.categoriasCreate",
        { nombre },
        adminToken,
      );
      const baja = await must<{ ok: true }>(
        "mutation",
        "catalogos.categoriasSetEstado",
        { id: creado.id, version: 1, estado: false },
        adminToken,
      );
      expect(baja.ok).toBe(true);
      const filaBaja = await pgQuery<{ version: number; estado: boolean }>(
        "select version::int, estado from categoria_producto where id = $1",
        [creado.id],
      );
      expect(filaBaja[0]?.estado).toBe(false);
      expect(filaBaja[0]?.version).toBe(2);

      const alta = await must<{ ok: true }>(
        "mutation",
        "catalogos.categoriasSetEstado",
        { id: creado.id, version: 2, estado: true },
        adminToken,
      );
      expect(alta.ok).toBe(true);
      const filas = await pgQuery<{ n: number }>(
        "select count(*)::int n from sync_cambio where tabla_origen = 'categoria_producto' and id_fila = $1 and operacion = 'update'",
        [creado.id],
      );
      expect(filas[0]?.n).toBeGreaterThanOrEqual(2);
    },
    T,
  );

  test(
    "duplicate name -> 409 with the exact catalog message",
    async () => {
      const nombre = `QA Cat Duplicada e2e ${sufijo()}`;
      await must<CatalogoDto>("mutation", "catalogos.categoriasCreate", { nombre }, adminToken);
      const dup = await trpc("mutation", "catalogos.categoriasCreate", { nombre }, adminToken);
      expect(dup.ok).toBe(false);
      if (dup.ok) return;
      expect(dup.status).toBe(409);
      expect(dup.errorMessage).toBe(`Ya existe una categoría con el nombre "${nombre}"`);
    },
    T,
  );

  test(
    "fk inexistente -> 400 (localidad with unknown municipio)",
    async () => {
      const res = await trpc(
        "mutation",
        "catalogos.localidadesCreate",
        { nombre: `QA Loc e2e ${sufijo()}`, fkMunicipio: "00000000-0000-4000-8000-000000000000" },
        adminToken,
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(400);
      expect(res.errorMessage).toBe("El municipio indicado no existe o está inactivo");
    },
    T,
  );

  test(
    "Agricultor mutations -> 403 'Solo el rol Admin puede modificar los catálogos'",
    async () => {
      for (const [path, input] of [
        ["catalogos.municipiosCreate", { nombre: `QA Mun Agro ${sufijo()}` }],
        [
          "catalogos.localidadesCreate",
          {
            nombre: `QA Loc Agro ${sufijo()}`,
            fkMunicipio: "00000000-0000-4000-8000-000000000000",
          },
        ],
        ["catalogos.categoriasCreate", { nombre: `QA Cat Agro ${sufijo()}` }],
        ["catalogos.unidadesCreate", { nombre: `QA Uni Agro ${sufijo()}` }],
      ] as const) {
        const res = await trpc("mutation", path, input, agroToken);
        expect(res.ok).toBe(false);
        if (res.ok) continue;
        expect(res.status).toBe(403);
        expect(res.errorCode).toBe("FORBIDDEN");
        expect(res.errorMessage).toBe("Solo el rol Admin puede modificar los catálogos");
      }
    },
    T,
  );

  test(
    "PULL delivers the soft-delete tombstone from an old checkpoint (§6.3.6)",
    async () => {
      const nombre = `QA Cat Tomb e2e ${sufijo()}`;
      // Checkpoint BEFORE any mutation: everything after must be delivered from here.
      const cp = await maxSeq("categoria_producto");
      const creado = await must<CatalogoDto>(
        "mutation",
        "catalogos.categoriasCreate",
        { nombre },
        adminToken,
      );
      await must(
        "mutation",
        "catalogos.categoriasSetEstado",
        { id: creado.id, version: 1, estado: false },
        adminToken,
      );
      const docs = await pullHasta<PullDoc>("categorias", cp, adminToken, (ds) =>
        ds.some((d) => d.id === creado.id),
      );
      const doc = docs.find((d) => d.id === creado.id);
      expect(doc?._deleted).toBe(true);
    },
    T,
  );
});
