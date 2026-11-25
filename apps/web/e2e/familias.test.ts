import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN,
  AGRO,
  DEV_PASSWORD,
  VENDEDOR,
  ensureServer,
  login,
  maxSeq,
  must,
  pgQuery,
  pgUna,
  pullHasta,
  sufijo,
  tokenDe,
  trpc,
  type TrpcErr,
} from "./helpers";

const T = 240_000;

type MiembroDto = {
  membresiaId: string;
  usuarioId: string;
  correo: string;
  esJefe: boolean;
  estado: boolean;
  version: number;
};

type FamiliaDto = {
  id: string;
  nombre: string;
  fkJefeUsuario: string | null;
  estado: boolean;
  version: number;
  limite: { id: string; monto: string; estado: boolean; version: number } | null;
  miembros: MiembroDto[];
};

type MembresiaDto = {
  id: string;
  fkUsuario: string;
  fkFamilia: string;
  estado: boolean;
  version: number;
};

type FamiliaPullDoc = {
  id: string;
  nombre: string;
  fkJefeUsuario: string | null;
  estado: boolean;
  version: number;
  _deleted: boolean;
};

type RegistroOk = { ok: true; correo: string };

async function registrarCliente(
  email: string,
  password: string,
  localidadId: string,
): Promise<string> {
  await must<RegistroOk>("mutation", "usuarios.register", {
    email,
    password,
    nombre: "Cliente",
    apellidoPaterno: `Fam${sufijo()}`,
    fkLocalidad: localidadId,
  });
  return (await login(email, password)).user.id;
}

async function localidadActivaId(): Promise<string> {
  return (await pgUna<{ id: string }>("select id from localidad where estado order by id limit 1"))
    .id;
}

describe("familias e2e (p0-familias proofs)", () => {
  let adminToken = "";
  let agroToken = "";
  let vendToken = "";
  let localidadId = "";

  beforeAll(async () => {
    await ensureServer();
    const ses = await login(ADMIN, DEV_PASSWORD);
    adminToken = ses.token;
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    vendToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    localidadId = await localidadActivaId();
  }, 90_000);

  test(
    "create transactionally writes familia + membresia + limite + conversacion + integrantes + 4 outbox rows",
    async () => {
      const s = sufijo();
      const jefeCorreo = `fam-jefe-${s}@e2e.local`;
      const jefeId = await registrarCliente(jefeCorreo, "ClaveFam123", localidadId);

      const res = await trpc<FamiliaDto>(
        "mutation",
        "familias.create",
        { nombre: `Familia e2e ${s}`, jefeEmail: jefeCorreo, montoLimite: 200 },
        adminToken,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.nombre).toBe(`Familia e2e ${s}`);
      expect(res.data.fkJefeUsuario).toBe(jefeId);
      expect(res.data.limite?.monto).toBe("200.00");
      expect(res.data.miembros).toHaveLength(1);
      expect(res.data.miembros[0]?.esJefe).toBe(true);

      const familiaId = res.data.id;
      const conteos = await pgUna<{
        familia: number;
        membresia: number;
        limite: number;
        conversacion: number;
        integrante: number;
        outbox: number;
      }>(
        `select
         (select count(*)::int from familia where id = $1) familia,
         (select count(*)::int from familia_usuario where fk_familia = $1) membresia,
         (select count(*)::int from limite_credito where fk_familia = $1) limite,
         (select count(*)::int from conversacion where fk_familia = $1 and estado) conversacion,
         (select count(*)::int from integrantes i join conversacion c on c.id = i.fk_conversacion where c.fk_familia = $1) integrante,
         (select count(*)::int from sync_cambio where id_fila = $1 or id_fila in
            (select id from familia_usuario where fk_familia = $1) or id_fila in
            (select id from limite_credito where fk_familia = $1) or id_fila in
            (select id from conversacion where fk_familia = $1)) outbox`,
        [familiaId],
      );
      expect(conteos.familia).toBe(1);
      expect(conteos.membresia).toBe(1);
      expect(conteos.limite).toBe(1);
      expect(conteos.conversacion).toBe(1);
      expect(conteos.integrante).toBe(1);
      expect(conteos.outbox).toBe(4);
    },
    T,
  );

  test(
    "addMember of a user already in a family -> 409 'El usuario ya pertenece a una familia activa'",
    async () => {
      const s = sufijo();
      const jefeCorreo = `fam-jefe2-${s}@e2e.local`;
      await registrarCliente(jefeCorreo, "ClaveFam123", localidadId);
      const familia = await must<FamiliaDto>(
        "mutation",
        "familias.create",
        { nombre: `Familia dup e2e ${s}`, jefeEmail: jefeCorreo },
        adminToken,
      );
      // agricultor@ is the seed family's jefe (active membership elsewhere).
      const res = await trpc(
        "mutation",
        "familias.addMember",
        { familiaId: familia.id, email: AGRO },
        adminToken,
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(409);
      expect(res.errorMessage).toBe("El usuario ya pertenece a una familia activa");
    },
    T,
  );

  test(
    "CONCURRENT addMember race -> exactly 1 success + 1 conflict (Q-21)",
    async () => {
      const s = sufijo();
      const jefeCorreo = `fam-jefe3-${s}@e2e.local`;
      await registrarCliente(jefeCorreo, "ClaveFam123", localidadId);
      const familia = await must<FamiliaDto>(
        "mutation",
        "familias.create",
        { nombre: `Familia race e2e ${s}`, jefeEmail: jefeCorreo },
        adminToken,
      );
      // A fresh family-less user added twice at the same instant: the DB partial unique
      // (familia_usuario_fk_usuario_activo_key) is the arbiter.
      const correo = `fam-race-${s}@e2e.local`;
      await registrarCliente(correo, "ClaveFam123", localidadId);

      const [a, b] = await Promise.all([
        trpc<MembresiaDto>(
          "mutation",
          "familias.addMember",
          { familiaId: familia.id, email: correo },
          adminToken,
        ),
        trpc<MembresiaDto>(
          "mutation",
          "familias.addMember",
          { familiaId: familia.id, email: correo },
          adminToken,
        ),
      ]);
      const ok = [a, b].filter((r) => r.ok);
      const conflicted = [a, b].filter((r) => !r.ok && r.status === 409);
      expect(ok).toHaveLength(1);
      expect(conflicted).toHaveLength(1);
      const mensaje = (conflicted[0] as TrpcErr | undefined)?.errorMessage;
      expect(mensaje).toBe("El usuario ya pertenece a una familia activa");

      const filas = await pgQuery<{ n: number }>(
        "select count(*)::int n from familia_usuario fu join usuario u on u.id = fu.fk_usuario where u.correo = $1 and fu.estado",
        [correo],
      );
      expect(filas[0]?.n).toBe(1);
    },
    T,
  );

  test(
    "baja/restore membership; jefe baja guard; setJefe reassignment",
    async () => {
      const s = sufijo();
      const jefeCorreo = `fam-jefe4-${s}@e2e.local`;
      const jefeId = await registrarCliente(jefeCorreo, "ClaveFam123", localidadId);
      const familia = await must<FamiliaDto>(
        "mutation",
        "familias.create",
        { nombre: `Familia baja e2e ${s}`, jefeEmail: jefeCorreo },
        adminToken,
      );
      const correo = `fam-miembro-${s}@e2e.local`;
      const miembroId = await registrarCliente(correo, "ClaveFam123", localidadId);
      const membresia = await must<MembresiaDto>(
        "mutation",
        "familias.addMember",
        { familiaId: familia.id, email: correo },
        adminToken,
      );

      // Jefe baja guard (400).
      const bajaJefe = await trpc(
        "mutation",
        "familias.removeMember",
        { membresiaId: familia.miembros[0]?.membresiaId, version: familia.miembros[0]?.version },
        adminToken,
      );
      expect(bajaJefe.ok).toBe(false);
      if (!bajaJefe.ok) {
        expect(bajaJefe.status).toBe(400);
        expect(bajaJefe.errorMessage).toBe(
          "No se puede dar de baja al jefe de la familia; reasigna el puesto primero",
        );
      }

      // Baja del miembro no-jefe (CAS v1 → v2) + integrante row deleted. The mutation
      // returns { ok: true }; the state proof is the DB row.
      await must<{ ok: true }>(
        "mutation",
        "familias.removeMember",
        { membresiaId: membresia.id, version: membresia.version },
        adminToken,
      );
      const bajaFila = await pgUna<{ estado: boolean; version: number }>(
        "select estado, version::int from familia_usuario where id = $1",
        [membresia.id],
      );
      expect(bajaFila.estado).toBe(false);
      expect(bajaFila.version).toBe(2);
      const integrantes = await pgQuery<{ n: number }>(
        `select count(*)::int n from integrantes i join conversacion c on c.id = i.fk_conversacion
       where c.fk_familia = $1 and i.fk_usuario = $2`,
        [familia.id, miembroId],
      );
      expect(integrantes[0]?.n).toBe(0);

      // Restore reactivates (and re-inserts the integrante row).
      const restore = await must<MembresiaDto>(
        "mutation",
        "familias.restoreMember",
        { membresiaId: membresia.id, version: 2 },
        adminToken,
      );
      expect(restore.estado).toBe(true);
      const integrantes2 = await pgQuery<{ n: number }>(
        `select count(*)::int n from integrantes i join conversacion c on c.id = i.fk_conversacion
       where c.fk_familia = $1 and i.fk_usuario = $2`,
        [familia.id, miembroId],
      );
      expect(integrantes2[0]?.n).toBe(1);

      // setJefe to the member, then the ex-jefe can be given baja.
      const setJefe = await must<{ ok: true }>(
        "mutation",
        "familias.setJefe",
        { familiaId: familia.id, usuarioId: miembroId, version: familia.version },
        adminToken,
      );
      expect(setJefe.ok).toBe(true);
      await must<{ ok: true }>(
        "mutation",
        "familias.removeMember",
        { membresiaId: familia.miembros[0]?.membresiaId, version: familia.miembros[0]?.version },
        adminToken,
      );
      const exJefe = await pgUna<{ estado: boolean }>(
        "select estado from familia_usuario where id = $1",
        [familia.miembros[0]?.membresiaId],
      );
      expect(exJefe.estado).toBe(false);
      void jefeId;
    },
    T,
  );

  test(
    "limite_credito XOR owner + negative monto -> 400; existing limite without version -> 409",
    async () => {
      const s = sufijo();
      const correo = `fam-indiv-${s}@e2e.local`;
      const usuarioId = await registrarCliente(correo, "ClaveFam123", localidadId);

      // XOR: both owners -> 400.
      const ambos = await trpc(
        "mutation",
        "familias.setLimite",
        { familiaId: "00000000-0000-4000-8000-000000000000", usuarioId, monto: 100 },
        adminToken,
      );
      expect(ambos.ok).toBe(false);
      if (!ambos.ok) expect(ambos.status).toBe(400);

      // Negative monto -> 400 (zod + DB CHECK backstop).
      const negativo = await trpc(
        "mutation",
        "familias.setLimite",
        { usuarioId, monto: -1 },
        adminToken,
      );
      expect(negativo.ok).toBe(false);
      if (!negativo.ok) expect(negativo.status).toBe(400);

      // Individual owner create (no version needed) → money string with 2 decimals.
      const creado = await must<{
        id: string;
        monto: string;
        fkUsuario: string | null;
        fkFamilia: string | null;
      }>("mutation", "familias.setLimite", { usuarioId, monto: 30.5 }, adminToken);
      expect(creado.monto).toBe("30.50");
      expect(creado.fkUsuario).toBe(usuarioId);
      expect(creado.fkFamilia).toBeNull();

      // Upsert of the existing row WITHOUT version → 409.
      const sinVersion = await trpc(
        "mutation",
        "familias.setLimite",
        { usuarioId, monto: 40 },
        adminToken,
      );
      expect(sinVersion.ok).toBe(false);
      if (!sinVersion.ok) {
        expect(sinVersion.status).toBe(409);
        expect(sinVersion.errorMessage).toBe(
          "Conflicto de versión: el límite ya existe; envíe su versión para actualizarlo",
        );
      }

      // With version → CAS update (Q-10 upsert by owner). The created row carries version 1.
      const actualizado = await must<{ monto: string }>(
        "mutation",
        "familias.setLimite",
        { usuarioId, monto: 40, version: 1 },
        adminToken,
      );
      expect(actualizado.monto).toBe("40.00");
    },
    T,
  );

  test(
    "Agricultor/Vendedor mutations -> 403 'Solo el rol Admin puede modificar las familias'",
    async () => {
      for (const token of [agroToken, vendToken]) {
        const res = await trpc(
          "mutation",
          "familias.create",
          { nombre: `Familia no-admin ${sufijo()}`, jefeEmail: AGRO },
          token,
        );
        expect(res.ok).toBe(false);
        if (res.ok) continue;
        expect(res.status).toBe(403);
        expect(res.errorMessage).toBe("Solo el rol Admin puede modificar las familias");
      }
    },
    T,
  );

  test(
    "PULL scoping: the member sees ONLY its own family; admin sees both (§11)",
    async () => {
      const s = sufijo();
      // Two families with different jefes (fresh users each run).
      const correoA = `fam-scope-a-${s}@e2e.local`;
      const correoB = `fam-scope-b-${s}@e2e.local`;
      await registrarCliente(correoA, "ClaveFam123", localidadId);
      await registrarCliente(correoB, "ClaveFam123", localidadId);

      const cpFamilia = await maxSeq("familia");
      const fA = await must<FamiliaDto>(
        "mutation",
        "familias.create",
        { nombre: `Familia scope A ${s}`, jefeEmail: correoA },
        adminToken,
      );
      const fB = await must<FamiliaDto>(
        "mutation",
        "familias.create",
        { nombre: `Familia scope B ${s}`, jefeEmail: correoB },
        adminToken,
      );

      // Member lane: pull from the pre-creation checkpoint → only their own family.
      const tokenA = await tokenDe(correoA, "ClaveFam123");
      const docsA = await pullHasta<FamiliaPullDoc>("familias", cpFamilia, tokenA, (ds) =>
        ds.some((d) => d.id === fA.id),
      );
      expect(docsA.some((d) => d.id === fA.id)).toBe(true);
      expect(docsA.some((d) => d.id === fB.id)).toBe(false);

      // Admin lane: both arrive.
      const docsAdmin = await pullHasta<FamiliaPullDoc>(
        "familias",
        cpFamilia,
        adminToken,
        (ds) => ds.some((d) => d.id === fA.id) && ds.some((d) => d.id === fB.id),
      );
      expect(docsAdmin.some((d) => d.id === fA.id)).toBe(true);
      expect(docsAdmin.some((d) => d.id === fB.id)).toBe(true);
    },
    T,
  );
});
