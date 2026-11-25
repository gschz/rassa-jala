import "./helpers";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";

import {
  ADMIN,
  BASE_URL,
  DEV_PASSWORD,
  PNG_BYTES,
  STORAGE_TEST_DIR,
  ensureServer,
  login,
  loginO,
  maxSeq,
  must,
  pgQuery,
  pgUna,
  pullHasta,
  sufijo,
  tokenDe,
  trpc,
  type Sesion,
} from "./helpers";

const T = 240_000;

type RegistroOk = { ok: true; correo: string };
type Creado = {
  id: string;
  correo: string;
  rol: string;
  debeCambiarPassword: boolean;
  passwordInicial?: string;
};
type UsuarioPullDoc = {
  id: string;
  correo: string;
  rol: string;
  estado: boolean;
  version: number;
  _deleted: boolean;
  passwordHash?: string;
};

// The slice of auth.me the gap-pass-8 localidad-label proof reads.
type Me = {
  persona: {
    fkLocalidad: string | null;
    localidad: { id: string; nombre: string; municipio: string; estado: boolean } | null;
  };
};

type FilaUsuario = {
  estado: boolean;
  debeCambiarPassword: boolean;
  passwordHash: string;
  rol: string;
};

async function localidadId(activa: boolean): Promise<string> {
  return (
    await pgUna<{ id: string }>(
      `select id from localidad where ${activa ? "" : "not "}estado order by id limit 1`,
    )
  ).id;
}

async function registrar(email: string, password: string, fkLocalidad: string): Promise<string> {
  await must<RegistroOk>("mutation", "usuarios.register", {
    email,
    password,
    nombre: "Cliente",
    apellidoPaterno: "E2E",
    fkLocalidad,
  });
  return (await login(email, password)).user.id;
}

async function filaUsuario(correo: string): Promise<FilaUsuario> {
  return pgUna<FilaUsuario>(
    `select u.estado, u.debe_cambiar_password as "debeCambiarPassword",
            u.password_hash as "passwordHash", r.nombre as rol
     from usuario u join roles r on r.id = u.fk_rol where u.correo = $1`,
    [correo],
  );
}

describe("usuarios e2e (p0-usuarios proofs)", () => {
  let adminToken = "";
  let adminId = "";
  let localidadActiva = "";
  let localidadInactiva = "";

  beforeAll(async () => {
    await ensureServer();
    const ses = await login(ADMIN, DEV_PASSWORD);
    adminToken = ses.token;
    adminId = ses.user.id;
    localidadActiva = await localidadId(true);
    // A freshly seeded DB has NO inactive localidad (the old inactive row was e2e
    // residue), so we flip a second ACTIVE one instead of relying on leftovers.
    // SQL-fixture precedent (liquidaciones.test.ts): direct SQL, restored in afterAll.
    // Chosen over a dedicated fixture row because creating a localidad would need a
    // municipio FK and extra cleanup, while the flip leaves no drift. It writes no
    // sync_cambio row (the outbox is app-written only), so it is PULL-invisible —
    // intentional: local-only fixture; slice-e2e's point-9 guard only audits the four
    // localidad rows it touched itself.
    localidadInactiva = (
      await pgUna<{ id: string }>(
        "select id from localidad where estado and id <> $1 order by id limit 1",
        [localidadActiva],
      )
    ).id;
    await pgQuery("update localidad set estado = false where id = $1", [localidadInactiva]);
  }, 90_000);

  afterAll(async () => {
    // Restore the flipped fixture so the DB is left with no new inactive residue.
    if (localidadInactiva) {
      await pgQuery("update localidad set estado = true where id = $1", [localidadInactiva]);
    }
  });

  test(
    "public register creates an ACTIVE Cliente with hash-only password + 2 outbox inserts",
    async () => {
      const correo = `reg-${sufijo()}@e2e.local`;
      const password = "ClienteE2E123";
      const cp = await maxSeq("usuario");
      await must<RegistroOk>("mutation", "usuarios.register", {
        email: correo,
        password,
        nombre: "Nueva",
        apellidoPaterno: "Cliente",
        fkLocalidad: localidadActiva,
      });

      const fila = await filaUsuario(correo);
      expect(fila.rol).toBe("Cliente");
      expect(fila.estado).toBe(true);
      expect(fila.debeCambiarPassword).toBe(false);
      expect(fila.passwordHash).toStartWith("$argon2");
      expect(fila.passwordHash).not.toContain(password);
      expect(fila.passwordHash).not.toBe(password);

      const { id: usuarioId } = await pgUna<{ id: string }>(
        "select id from usuario where correo = $1",
        [correo],
      );
      const { fkPersona } = await pgUna<{ fkPersona: string }>(
        'select fk_persona as "fkPersona" from usuario where id = $1',
        [usuarioId],
      );
      const outbox = await pgQuery<{ tabla: string; operacion: string; actor: string }>(
        `select tabla_origen as tabla, operacion, actor from sync_cambio
       where id_fila in ($1, $2) and tabla_origen in ('usuario', 'persona') order by tabla_origen`,
        [usuarioId, fkPersona],
      );
      expect(outbox.length).toBe(2);
      for (const filaOutbox of outbox) {
        expect(filaOutbox.operacion).toBe("insert");
        expect(filaOutbox.actor).toBe(usuarioId);
      }

      // Login works right away (public registration issues no session itself).
      const ses = await login(correo, password);
      expect(ses.user.rol).toBe("Cliente");
      expect(ses.user.debeCambiarPassword).toBe(false);

      // PULL from the pre-registration checkpoint delivers the fresh user doc.
      const docs = await pullHasta<UsuarioPullDoc>("usuarios", cp, adminToken, (ds) =>
        ds.some((d) => d.id === usuarioId),
      );
      const doc = docs.find((d) => d.id === usuarioId);
      expect(doc?.correo).toBe(correo);
      expect(doc?.passwordHash).toBeUndefined();
    },
    T,
  );

  test(
    "duplicate email -> 409 'El correo ya está registrado'",
    async () => {
      const correo = `dup-${sufijo()}@e2e.local`;
      await registrar(correo, "ClienteE2E123", localidadActiva);
      const res = await trpc("mutation", "usuarios.register", {
        email: correo,
        password: "ClienteE2E123",
        nombre: "Otra",
        apellidoPaterno: "Vez",
        fkLocalidad: localidadActiva,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(409);
      expect(res.errorCode).toBe("CONFLICT");
      expect(res.errorMessage).toBe("El correo ya está registrado");
    },
    T,
  );

  test(
    "inactive localidad -> 400 'La localidad seleccionada no está disponible'",
    async () => {
      const res = await trpc("mutation", "usuarios.register", {
        email: `loc-${sufijo()}@e2e.local`,
        password: "ClienteE2E123",
        nombre: "Sin",
        apellidoPaterno: "Localidad",
        fkLocalidad: localidadInactiva,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(400);
      expect(res.errorMessage).toBe("La localidad seleccionada no está disponible");
    },
    T,
  );

  test(
    "persona profile fields: register persists them, updatePerfil changes them, invalid sexo rejected",
    async () => {
      const s = sufijo();
      const correo = `perf-${s}@e2e.local`;
      const password = "ClienteE2E123";
      await must<RegistroOk>("mutation", "usuarios.register", {
        email: correo,
        password,
        nombre: "Perfil",
        apellidoPaterno: "Campos",
        fkLocalidad: localidadActiva,
        telefono: "+52 951 000 0000",
        fechaNacimiento: "1995-06-15",
        sexo: "F",
        domicilio: "Calle de las flores 123, centro",
      });

      const personaDe = async (idUsuario: string) =>
        await pgUna<{
          telefono: string | null;
          fechaNacimiento: string | null;
          sexo: string | null;
          domicilio: string | null;
        }>(
          `select p.telefono, p.fecha_nacimiento::text as "fechaNacimiento", p.sexo, p.domicilio
           from persona p join usuario u on u.fk_persona = p.id where u.id = $1`,
          [idUsuario],
        );

      const id = (await login(correo, password)).user.id;
      const creada = await personaDe(id);
      expect(creada.telefono).toBe("+52 951 000 0000");
      expect(creada.fechaNacimiento).toBe("1995-06-15");
      expect(creada.sexo).toBe("F");
      expect(creada.domicilio).toBe("Calle de las flores 123, centro");

      // updatePerfil overwrites the fields (read-back through the same row).
      const token = await tokenDe(correo, password);
      await must(
        "mutation",
        "usuarios.updatePerfil",
        {
          telefono: "9510000000",
          fechaNacimiento: "1990-01-31",
          sexo: "O",
          domicilio: "Nueva direccion 456",
        },
        token,
      );
      const actualizada = await personaDe(id);
      expect(actualizada.telefono).toBe("9510000000");
      expect(actualizada.fechaNacimiento).toBe("1990-01-31");
      expect(actualizada.sexo).toBe("O");
      expect(actualizada.domicilio).toBe("Nueva direccion 456");

      // Invalid sexo never passes the schema (DB CHECK would reject it too).
      const invalido = await trpc("mutation", "usuarios.register", {
        email: `sexo-${s}@e2e.local`,
        password,
        nombre: "Sexo",
        apellidoPaterno: "Invalido",
        fkLocalidad: localidadActiva,
        sexo: "X",
      });
      expect(invalido.ok).toBe(false);
      if (!invalido.ok) {
        expect(invalido.status).toBe(400);
        expect(invalido.errorCode).toBe("BAD_REQUEST");
      }
    },
    T,
  );

  test(
    "profile photo: upload persists persona row + /storage read-back; replacement unlinks the old file; quitar nulls it",
    async () => {
      const correo = `foto-${sufijo()}@e2e.local`;
      const password = "ClienteE2E123";
      await registrar(correo, password, localidadActiva);
      const token = await tokenDe(correo, password);
      const id = (await pgUna<{ id: string }>("select id from usuario where correo = $1", [correo]))
        .id;

      const subir = (nombre: string): Promise<Response> => {
        const form = new FormData();
        form.append("file", new File([PNG_BYTES], nombre, { type: "image/png" }));
        return fetch(`${BASE_URL}/upload/perfil`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: form,
        });
      };
      const rutaDe = async (idUsuario: string) =>
        await pgUna<{ fotoKey: string | null; fotoUrl: string | null }>(
          `select p.foto_key as "fotoKey", p.foto_url as "fotoUrl"
           from persona p join usuario u on u.fk_persona = p.id where u.id = $1`,
          [idUsuario],
        );
      const existeArchivo = async (ruta: string): Promise<boolean> =>
        await stat(ruta)
          .then(() => true)
          .catch(() => false);

      // 1) First upload: the multipart bridge persists the persona reference AND
      //    the stored file is served back byte-identical by GET /storage/perfil/... .
      const res1 = await subir("foto.png");
      expect(res1.status).toBe(200);
      const foto1 = (await res1.json()) as { fotoKey: string; fotoUrl: string };
      expect(foto1.fotoKey.startsWith("perfil/")).toBe(true);
      expect(foto1.fotoUrl).toBe(`/storage/${foto1.fotoKey}`);
      const fila1 = await rutaDe(id);
      expect(fila1.fotoKey).toBe(foto1.fotoKey);
      expect(fila1.fotoUrl).toBe(foto1.fotoUrl);
      const servida = await fetch(`${BASE_URL}${foto1.fotoUrl}`);
      expect(servida.status).toBe(200);
      expect(servida.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await servida.arrayBuffer())).toEqual(new Uint8Array(PNG_BYTES));
      expect(await existeArchivo(`${STORAGE_TEST_DIR}/${foto1.fotoKey}`)).toBe(true);

      // 2) Replacement: a NEW key replaces the old one in the row and the OLD
      //    file is unlinked (best-effort unlink → it actually happened here).
      const res2 = await subir("otra.png");
      expect(res2.status).toBe(200);
      const foto2 = (await res2.json()) as { fotoKey: string; fotoUrl: string };
      expect(foto2.fotoKey).not.toBe(foto1.fotoKey);
      const fila2 = await rutaDe(id);
      expect(fila2.fotoKey).toBe(foto2.fotoKey);
      expect(await existeArchivo(`${STORAGE_TEST_DIR}/${foto1.fotoKey}`)).toBe(false);
      expect(await existeArchivo(`${STORAGE_TEST_DIR}/${foto2.fotoKey}`)).toBe(true);

      // 3) Quitar: the persona reference is nulled and the stored file removed.
      await must("mutation", "usuarios.quitarFoto", null, token);
      const fila3 = await rutaDe(id);
      expect(fila3.fotoKey).toBeNull();
      expect(fila3.fotoUrl).toBeNull();
      expect(await existeArchivo(`${STORAGE_TEST_DIR}/${foto2.fotoKey}`)).toBe(false);

      // 4) The bridge is authenticated: without a token it is 401 (no file written).
      const formSinToken = new FormData();
      formSinToken.append("file", new File([PNG_BYTES], "anon.png", { type: "image/png" }));
      const sinToken = await fetch(`${BASE_URL}/upload/perfil`, {
        method: "POST",
        body: formSinToken,
      });
      expect(sinToken.status).toBe(401);
    },
    T,
  );

  test(
    "auth.me resolves the CURRENT localidad (name) even when inactive — /perfil's select never shows the raw UUID",
    async () => {
      const correo = `locme-${sufijo()}@e2e.local`;
      const id = await registrar(correo, "ClienteE2E123", localidadActiva);
      const token = await tokenDe(correo, "ClienteE2E123");
      // Force the persona onto the INACTIVE fixture localidad (direct SQL — the
      // established e2e pattern for this fixture; updatePerfil would reject an
      // inactive localidad by design).
      await pgQuery(
        "update persona set fk_localidad = $1 where id = (select fk_persona from usuario where id = $2)",
        [localidadInactiva, id],
      );
      const fila = await pgUna<{ nombre: string }>("select nombre from localidad where id = $1", [
        localidadInactiva,
      ]);
      const me = await must<Me>("query", "auth.me", null, token);
      expect(me.persona.fkLocalidad).toBe(localidadInactiva);
      expect(me.persona.localidad?.id).toBe(localidadInactiva);
      expect(me.persona.localidad?.estado).toBe(false);
      // The NAME (never the raw UUID) rides the response, so the select can label it.
      expect(me.persona.localidad?.nombre).toBe(fila.nombre);
    },
    T,
  );

  test(
    "admin provisioning returns passwordInicial ONCE, stores hash only, and gates until changePassword",
    async () => {
      const correo = `vend-${sufijo()}@e2e.local`;
      const creado = await must<Creado>(
        "mutation",
        "usuarios.create",
        {
          email: correo,
          generate: true,
          rol: "Vendedor",
          nombre: "Vendedor",
          apellidoPaterno: "E2E",
          fkLocalidad: localidadActiva,
        },
        adminToken,
      );
      expect(creado.debeCambiarPassword).toBe(true);
      expect(creado.passwordInicial).toBeDefined();
      expect(creado.passwordInicial!.length).toBe(12);
      expect(JSON.stringify(creado.passwordInicial)).not.toBe("");

      // The plaintext is never persisted: only an Argon2id hash lives in the row.
      const fila = await filaUsuario(correo);
      expect(fila.rol).toBe("Vendedor");
      expect(fila.debeCambiarPassword).toBe(true);
      expect(fila.passwordHash).toStartWith("$argon2");
      expect(fila.passwordHash).not.toContain(creado.passwordInicial!);

      const ses = await login(correo, creado.passwordInicial!);
      expect(ses.user.debeCambiarPassword).toBe(true);

      // Forced-change gate: every non-allowlisted procedure is blocked.
      const gated = await trpc("query", "productos.list", {}, ses.token);
      expect(gated.ok).toBe(false);
      if (!gated.ok) {
        expect(gated.status).toBe(403);
        expect(gated.errorMessage).toBe("Debe cambiar su contraseña antes de continuar");
      }

      await must(
        "mutation",
        "auth.changePassword",
        {
          currentPassword: creado.passwordInicial!,
          newPassword: "VendedorPropio123",
        },
        ses.token,
      );

      // Same access token now passes (the flag is read from the DB on every call).
      const liberado = await trpc("query", "productos.list", {}, ses.token);
      expect(liberado.ok).toBe(true);

      // An explicit admin password also forces the change and is NOT echoed back.
      const explicito = await must<Creado>(
        "mutation",
        "usuarios.create",
        {
          email: `expl-${sufijo()}@e2e.local`,
          password: "Explicita123",
          rol: "Vendedor",
          nombre: "Explicito",
          apellidoPaterno: "E2E",
        },
        adminToken,
      );
      expect(explicito.passwordInicial).toBeUndefined();
      expect(explicito.debeCambiarPassword).toBe(true);
    },
    T,
  );

  test(
    "changeRol updates the DB role; self role-change -> 403",
    async () => {
      const correo = `rol-${sufijo()}@e2e.local`;
      const creado = await must<Creado>(
        "mutation",
        "usuarios.create",
        {
          email: correo,
          generate: true,
          rol: "Cliente",
          nombre: "Cambio",
          apellidoPaterno: "Rol",
        },
        adminToken,
      );
      const antes = await filaUsuario(correo);
      expect(antes.rol).toBe("Cliente");

      await must<{ ok: true }>(
        "mutation",
        "usuarios.changeRol",
        { id: creado.id, rol: "Vendedor" },
        adminToken,
      );
      const despues = await filaUsuario(correo);
      expect(despues.rol).toBe("Vendedor");
      const version = await pgUna<{ version: number }>(
        "select version::int from usuario where id = $1",
        [creado.id],
      );
      expect(version.version).toBe(2);

      const self = await trpc(
        "mutation",
        "usuarios.changeRol",
        { id: adminId, rol: "Cliente" },
        adminToken,
      );
      expect(self.ok).toBe(false);
      if (!self.ok) {
        expect(self.status).toBe(403);
        expect(self.errorMessage).toBe("No puedes cambiar tu propio rol");
      }
    },
    T,
  );

  test(
    "deactivation revokes refresh tokens in-tx; the still-valid access token fails on the next call",
    async () => {
      const correo = `baja-${sufijo()}@e2e.local`;
      const creado = await must<Creado>(
        "mutation",
        "usuarios.create",
        {
          email: correo,
          generate: true,
          rol: "Vendedor",
          nombre: "Baja",
          apellidoPaterno: "E2E",
        },
        adminToken,
      );
      const ses = await login(correo, creado.passwordInicial!);
      await must(
        "mutation",
        "auth.changePassword",
        {
          currentPassword: creado.passwordInicial!,
          newPassword: "BajaPropio123",
        },
        ses.token,
      );
      const vigente: Sesion = await login(correo, "BajaPropio123");

      const activosAntes = await pgUna<{ n: number }>(
        "select count(*)::int n from refresh_token where fk_usuario = $1 and revoked_at is null",
        [creado.id],
      );
      expect(activosAntes.n).toBeGreaterThan(0);

      await must<{ ok: true }>(
        "mutation",
        "usuarios.setEstado",
        { id: creado.id, estado: false },
        adminToken,
      );
      const activosDespues = await pgUna<{ n: number }>(
        "select count(*)::int n from refresh_token where fk_usuario = $1 and revoked_at is null",
        [creado.id],
      );
      expect(activosDespues.n).toBe(0);

      const me = await trpc("query", "auth.me", null, vigente.token);
      expect(me.ok).toBe(false);
      if (!me.ok) {
        expect(me.status).toBe(401);
        expect(me.errorMessage).toBe("Usuario desactivado");
      }
      // Login is refused too.
      expect(await loginO(correo, "BajaPropio123")).toBeNull();

      const self = await trpc(
        "mutation",
        "usuarios.setEstado",
        { id: adminId, estado: false },
        adminToken,
      );
      expect(self.ok).toBe(false);
      if (!self.ok) {
        expect(self.status).toBe(403);
        expect(self.errorMessage).toBe("No puedes cambiar tu propio estado");
      }
    },
    T,
  );

  test(
    "resetPassword invalidates the old password, revokes sessions and re-arms the forced change",
    async () => {
      const correo = `reset-${sufijo()}@e2e.local`;
      const passwordVieja = "ViejaClave123";
      const id = await registrar(correo, passwordVieja, localidadActiva);
      expect(await loginO(correo, passwordVieja)).not.toBeNull();

      const reset = await must<{ ok: true; passwordInicial?: string }>(
        "mutation",
        "usuarios.resetPassword",
        { id, generate: true },
        adminToken,
      );
      expect(reset.passwordInicial).toBeDefined();
      const nueva = reset.passwordInicial!;

      expect(await loginO(correo, passwordVieja)).toBeNull();
      const ses = await login(correo, nueva);
      expect(ses.user.debeCambiarPassword).toBe(true);
      const activos = await pgUna<{ n: number }>(
        "select count(*)::int n from refresh_token where fk_usuario = $1 and revoked_at is null",
        [id],
      );
      // login() after the reset issued one fresh token; the reset revoked everything older.
      expect(activos.n).toBe(1);

      const gated = await trpc("query", "productos.list", {}, ses.token);
      expect(gated.ok).toBe(false);
      if (!gated.ok) expect(gated.status).toBe(403);
      expect((await filaUsuario(correo)).passwordHash).not.toContain(nueva);
    },
    T,
  );

  test(
    "PULL scoping: admin sees everyone; a family-less user sees only itself (no passwordHash)",
    async () => {
      const s = sufijo();
      const correoA = `pull-a-${s}@e2e.local`;
      const correoB = `pull-b-${s}@e2e.local`;
      const cp = await maxSeq("usuario");
      const idA = await registrar(correoA, "ClienteE2E123", localidadActiva);
      const idB = await registrar(correoB, "ClienteE2E123", localidadActiva);
      const tokenA = await tokenDe(correoA, "ClienteE2E123");

      const docsA = await pullHasta<UsuarioPullDoc>("usuarios", cp, tokenA, (ds) =>
        ds.some((d) => d.id === idA),
      );
      expect(docsA.some((d) => d.id === idA)).toBe(true);
      expect(docsA.some((d) => d.id === idB)).toBe(false);
      for (const doc of docsA) expect(doc.passwordHash).toBeUndefined();

      const docsAdmin = await pullHasta<UsuarioPullDoc>(
        "usuarios",
        cp,
        adminToken,
        (ds) => ds.some((d) => d.id === idA) && ds.some((d) => d.id === idB),
      );
      expect(docsAdmin.some((d) => d.id === idA)).toBe(true);
      expect(docsAdmin.some((d) => d.id === idB)).toBe(true);
    },
    T,
  );

  test(
    "last-active-Admin race -> exactly one demotion wins, the other 409 (Q-07/T3 guard)",
    async () => {
      const rolDe = async (id: string): Promise<string> =>
        (
          await pgUna<{ rol: string }>(
            "select r.nombre as rol from usuario u join roles r on r.id = u.fk_rol where u.id = $1",
            [id],
          )
        ).rol;

      // Converge first: leave the seed admin as the ONLY active Admin (a previous failed
      // run may have left extra admins behind).
      const extras = await pgQuery<{ id: string }>(
        `select u.id from usuario u join roles r on r.id = u.fk_rol
       where r.nombre = 'Admin' and u.estado and u.id <> $1`,
        [adminId],
      );
      for (const extra of extras) {
        await must<{ ok: true }>(
          "mutation",
          "usuarios.changeRol",
          { id: extra.id, rol: "Cliente" },
          adminToken,
        );
      }

      let exitos = 0;
      let conflictos = 0;
      let ultimoConflicto: { errorCode: string; errorMessage: string } | null = null;

      // A stale-role read can also turn the loser into a legitimate 403 (role freshness is
      // the OUTER guard); each attempt recreates the exactly-two-admins state, so retry.
      for (let intento = 0; intento < 3 && !(exitos === 1 && conflictos === 1); intento++) {
        const correo = `adm-${sufijo()}@e2e.local`;
        const creado = await must<Creado>(
          "mutation",
          "usuarios.create",
          {
            email: correo,
            generate: true,
            rol: "Admin",
            nombre: "Admin",
            apellidoPaterno: "Carrera",
          },
          adminToken,
        );
        const ses = await login(correo, creado.passwordInicial!);
        await must(
          "mutation",
          "auth.changePassword",
          {
            currentPassword: creado.passwordInicial!,
            newPassword: "AdminPropio123",
          },
          ses.token,
        );

        // Exactly two active admins: the seed admin and the fresh one.
        const [rSeed, rNuevo] = await Promise.all([
          trpc("mutation", "usuarios.changeRol", { id: creado.id, rol: "Cliente" }, adminToken),
          trpc("mutation", "usuarios.changeRol", { id: adminId, rol: "Cliente" }, ses.token),
        ]);
        exitos = [rSeed, rNuevo].filter((r) => r.ok).length;
        const perdedores = [rSeed, rNuevo].filter((r) => !r.ok);
        conflictos = perdedores.filter((r) => !r.ok && r.status === 409).length;
        const conflicto = perdedores.find((r) => !r.ok && r.status === 409);
        if (conflicto && !conflicto.ok) {
          ultimoConflicto = {
            errorCode: conflicto.errorCode,
            errorMessage: conflicto.errorMessage,
          };
        }

        // Cleanup: seed admin back to Admin (via the fresh admin when it won), then demote
        // the fresh one so the next attempt/run starts from one Admin again.
        if ((await rolDe(adminId)) !== "Admin") {
          await must<{ ok: true }>(
            "mutation",
            "usuarios.changeRol",
            { id: adminId, rol: "Admin" },
            ses.token,
          );
        }
        if ((await rolDe(creado.id)) === "Admin") {
          await must<{ ok: true }>(
            "mutation",
            "usuarios.changeRol",
            { id: creado.id, rol: "Cliente" },
            adminToken,
          );
        }
      }

      expect(exitos).toBe(1);
      expect(conflictos).toBe(1);
      expect(ultimoConflicto?.errorCode).toBe("CONFLICT");
      expect(ultimoConflicto?.errorMessage).toBe("Debe existir al menos un Admin activo");
    },
    T,
  );
});
