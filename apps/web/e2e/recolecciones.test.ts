import "./helpers";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN,
  AGRO,
  CLIENTE,
  DEV_PASSWORD,
  VENDEDOR,
  ensureFixtures,
  ensureServer,
  pgQuery,
  pgUna,
  sufijo,
  tokenDe,
  trpc,
} from "./helpers";

const T = 240_000;

// P0 Recolecciones e2e (docs/roadmap.md §5 P0-B; database.md §3.5/M-14, §4.2 R1;
// scope.md §3.1). Rules extracted from legacy/rassa_back/rassa/blueprints/recoleccion:
// - R1: ONE active slot per (agricultor, fecha) — partial unique excluding 'cancelado'.
// - Strict state machine: pendiente→[en_ruta,cancelado], en_ruta→[recolectado,
//   cancelado]; late pendiente (fecha < hoy Mazatlan) may jump directly to
//   recolectado but NOT en_ruta; same-state → 400.
// - cancelar is IDEMPOTENT (200 "ya estaba cancelada", no historial).
// - Roles: Admin/Vendedor operate; Agricultor reads own only; Cliente 403.
//
// COL23 note: the module is ONLINE-CONFIRM (database.md §6.2 "Escritura offline: No"
// + synchronization.md §9) — no RxDB collection and no PULL/PUSH lane exist for
// recolecciones, so this suite proves the online procedures + DB guarantees directly
// (the PULL checkpoint/breach proofs live in the collection suites).

type AgricultorDto = { id: string; nombre: string; apellidoPaterno: string };

type RecoleccionDto = {
  id: string;
  fkAgricultor: string;
  agricultorNombre: string | null;
  localidad: string | null;
  municipio: string | null;
  fechaRecoleccion: string;
  horaInicio: string | null;
  horaFin: string | null;
  estado: string;
  comentarios: string | null;
  version: number;
  actualizadoEn: string;
};

type CancelarDto = { recoleccion: RecoleccionDto; mensaje: string };

const MSG_DUPLICADO = "El agricultor ya tiene una recolección programada para esta fecha.";

// A stable future date: the farmer under test is created per RUN (sufijo), so fixed
// dates never collide across runs — re-run safe ×2 without re-seeding.
const FECHA_FUTURA = "2027-06-15";
const FECHA_FUTURA_2 = "2027-06-16";
const FECHA_FUTURA_3 = "2027-06-17";
const FECHA_PASADA = "2020-01-01";

/**
 * SQL fixture: a per-run Agricultor (copy of admin's hash → logs in with
 * DEV_PASSWORD). Upserts keep re-runs convergent; no login is required for the
 * API lanes that only need the id.
 */
async function crearAgricultorFixture(correo: string, nombre: string): Promise<string> {
  const localidad = await pgUna<{ id: string }>(
    "select id from localidad where nombre = 'Tepic' and estado order by id limit 1",
  );
  const personaId = crypto.randomUUID();
  await pgQuery(
    `insert into persona (id, nombre, apellido_paterno, fk_localidad)
     values ($1, $2, 'Reco', $3)
     on conflict (id) do nothing`,
    [personaId, nombre, localidad.id],
  );
  await pgQuery(
    `insert into usuario (id, correo, password_hash, fk_persona, fk_rol, estado)
     select gen_random_uuid(), $1, u.password_hash, $2, r.id, true
     from usuario u, roles r
     where u.correo = $3 and r.nombre = 'Agricultor'
     on conflict (correo) do nothing`,
    [correo, personaId, ADMIN],
  );
  return (await pgUna<{ id: string }>("select id from usuario where correo = $1", [correo])).id;
}

describe("recolecciones e2e (p0-recolecciones proofs)", () => {
  let adminToken = "";
  let vendedorToken = "";
  let agroToken = "";
  let clienteToken = "";
  // Per-run farmer: every slot test uses fixed dates without cross-run collisions.
  let farmerId = "";
  let vendedorDbId = "";

  beforeAll(async () => {
    await ensureServer();
    await ensureFixtures();
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
    vendedorToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    clienteToken = await tokenDe(CLIENTE, DEV_PASSWORD);
    const s = sufijo();
    farmerId = await crearAgricultorFixture(`e2e-reco-${s}@fixture.local`, `AgroReco${s}`);
    vendedorDbId = (
      await pgUna<{ id: string }>("select id from usuario where correo = $1", [VENDEDOR])
    ).id;
  }, 90_000);

  const crearRecoleccion = async (
    entrada: {
      fkAgricultor: string;
      fechaRecoleccion: string;
      horaInicio?: string;
      horaFin?: string;
      comentarios?: string;
      operationId?: string;
    },
    token = vendedorToken,
  ) => trpc<RecoleccionDto>("mutation", "recolecciones.crear", entrada, token);

  test(
    "agricultores: Admin/Vendedor listan agricultores activos; Cliente 403",
    async () => {
      const res = await trpc<AgricultorDto[]>(
        "query",
        "recolecciones.agricultores",
        {},
        vendedorToken,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        const ids = res.data.map((a) => a.id);
        expect(ids).toContain(farmerId);
      }
      const resAdmin = await trpc<AgricultorDto[]>(
        "query",
        "recolecciones.agricultores",
        {},
        adminToken,
      );
      expect(resAdmin.ok).toBe(true);
      const resCliente = await trpc("query", "recolecciones.agricultores", {}, clienteToken);
      expect(resCliente.ok).toBe(false);
      if (!resCliente.ok) expect(resCliente.status).toBe(403);
    },
    T,
  );

  test(
    "crear: agenda en una tx — fila pendiente + historial (anterior null) + outbox",
    async () => {
      const res = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: FECHA_FUTURA,
        horaInicio: "08:00",
        horaFin: "10:00",
        comentarios: "Cosecha de tomate",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.estado).toBe("pendiente");
      expect(res.data.fechaRecoleccion).toBe(FECHA_FUTURA);
      expect(res.data.horaInicio).toBe("08:00:00");
      expect(res.data.horaFin).toBe("10:00:00");

      const fila = await pgUna<{ estado: string; version: number }>(
        "select estado, version from recoleccion where id = $1",
        [res.data.id],
      );
      expect(fila.estado).toBe("pendiente");

      const historial = await pgQuery<{
        estado_anterior: string | null;
        estado_nuevo: string;
        fk_cambiado_por: string | null;
      }>(
        "select estado_anterior, estado_nuevo, fk_cambiado_por from historial_estado_recoleccion where fk_recoleccion = $1",
        [res.data.id],
      );
      expect(historial.length).toBe(1);
      expect(historial[0]?.estado_anterior).toBeNull();
      expect(historial[0]?.estado_nuevo).toBe("pendiente");
      expect(historial[0]?.fk_cambiado_por).toBe(vendedorDbId);

      const outbox = await pgQuery<{ tabla_origen: string; operacion: string }>(
        "select tabla_origen, operacion from sync_cambio where (tabla_origen = 'recoleccion' and id_fila = $1) or (tabla_origen = 'historial_estado_recoleccion' and id_fila in (select id from historial_estado_recoleccion where fk_recoleccion = $1))",
        [res.data.id],
      );
      expect(outbox.some((o) => o.tabla_origen === "recoleccion" && o.operacion === "insert")).toBe(
        true,
      );
      expect(
        outbox.some(
          (o) => o.tabla_origen === "historial_estado_recoleccion" && o.operacion === "insert",
        ),
      ).toBe(true);
    },
    T,
  );

  test(
    "R1 unicidad de slot: segundo create del mismo (agricultor, fecha) → 400 con mensaje legacy y count=1",
    async () => {
      const primera = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: FECHA_FUTURA_2,
      });
      expect(primera.ok).toBe(true);

      const antes = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from recoleccion where fk_agricultor = $1 and fecha_recoleccion = $2",
          [farmerId, FECHA_FUTURA_2],
        )
      ).n;

      const dup = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: FECHA_FUTURA_2,
      });
      expect(dup.ok).toBe(false);
      if (!dup.ok) {
        expect(dup.status).toBe(400);
        expect(dup.errorMessage).toBe(MSG_DUPLICADO);
      }

      const despues = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from recoleccion where fk_agricultor = $1 and fecha_recoleccion = $2",
          [farmerId, FECHA_FUTURA_2],
        )
      ).n;
      expect(despues).toBe(antes);
      expect(despues).toBe(1);
    },
    T,
  );

  test(
    "carrera de slot: dos creates concurrentes del mismo (agricultor, fecha) → exactamente 1 gana, count=1",
    async () => {
      const resultados = await Promise.all([
        crearRecoleccion({ fkAgricultor: farmerId, fechaRecoleccion: FECHA_FUTURA_3 }),
        crearRecoleccion({ fkAgricultor: farmerId, fechaRecoleccion: FECHA_FUTURA_3 }),
      ]);
      const exitos = resultados.filter((r) => r.ok).length;
      expect(exitos).toBe(1);
      const perdedor = resultados.find((r) => !r.ok);
      if (perdedor && !perdedor.ok) {
        expect(perdedor.status).toBe(400);
        expect(perdedor.errorMessage).toBe(MSG_DUPLICADO);
      }
      const n = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from recoleccion where fk_agricultor = $1 and fecha_recoleccion = $2",
          [farmerId, FECHA_FUTURA_3],
        )
      ).n;
      expect(n).toBe(1);
    },
    T,
  );

  test(
    "replay idempotente: mismo operationId → mismo veredicto/respuesta, PG counts sin cambios",
    async () => {
      const operationId = crypto.randomUUID();
      const primera = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-18",
        operationId,
      });
      expect(primera.ok).toBe(true);
      if (!primera.ok) return;

      const countAntes = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from recoleccion where fk_agricultor = $1 and fecha_recoleccion = $2",
          [farmerId, "2027-06-18"],
        )
      ).n;
      const syncOpAntes = (
        await pgUna<{ n: number }>("select count(*)::int n from sync_operacion where id = $1", [
          operationId,
        ])
      ).n;

      const replay = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-18",
        operationId,
      });
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.data.id).toBe(primera.data.id);

      const countDespues = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from recoleccion where fk_agricultor = $1 and fecha_recoleccion = $2",
          [farmerId, "2027-06-18"],
        )
      ).n;
      const syncOpDespues = (
        await pgUna<{ n: number }>("select count(*)::int n from sync_operacion where id = $1", [
          operationId,
        ])
      ).n;
      expect(countDespues).toBe(countAntes);
      expect(countDespues).toBe(1);
      expect(syncOpDespues).toBe(syncOpAntes);
      expect(syncOpDespues).toBe(1);
    },
    T,
  );

  test(
    "validaciones de dominio: fecha pasada, horas par/orden y agricultor inválido → 400 con mensajes legacy",
    async () => {
      const pasada = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: FECHA_PASADA,
      });
      expect(pasada.ok).toBe(false);
      if (!pasada.ok) expect(pasada.errorMessage).toBe("La fecha no puede ser anterior a hoy.");

      const mediaHora = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-19",
        horaInicio: "08:00",
      });
      expect(mediaHora.ok).toBe(false);
      if (!mediaHora.ok) {
        expect(mediaHora.errorMessage).toBe(
          "Deben indicarse ambas horas (inicio y fin) o ninguna.",
        );
      }

      const ordenInverso = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-19",
        horaInicio: "10:00",
        horaFin: "09:00",
      });
      expect(ordenInverso.ok).toBe(false);
      if (!ordenInverso.ok) {
        expect(ordenInverso.errorMessage).toBe("hora_fin debe ser posterior a hora_inicio.");
      }

      // Cliente (rol sin Agricultor) como fkAgricultor → rol inválido.
      const clienteId = (
        await pgUna<{ id: string }>("select id from usuario where correo = $1", [CLIENTE])
      ).id;
      const sinRol = await crearRecoleccion({
        fkAgricultor: clienteId,
        fechaRecoleccion: "2027-06-19",
      });
      expect(sinRol.ok).toBe(false);
      if (!sinRol.ok) {
        expect(sinRol.errorMessage).toBe("El agricultor especificado no tiene rol Agricultor.");
      }

      // bloqueado@: estado=false → inactivo.
      const bloqueadoId = (
        await pgUna<{ id: string }>("select id from usuario where correo = $1", [
          "bloqueado@rassa.local",
        ])
      ).id;
      const inactivo = await crearRecoleccion({
        fkAgricultor: bloqueadoId,
        fechaRecoleccion: "2027-06-19",
      });
      expect(inactivo.ok).toBe(false);
      if (!inactivo.ok) {
        expect(inactivo.errorMessage).toBe("El agricultor especificado no existe o está inactivo.");
      }
    },
    T,
  );

  test(
    "scoping: Cliente 403 en listar/detalle; Agricultor solo propias; Agricultor no opera (403)",
    async () => {
      const res = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-20",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const idFila = res.data.id;

      const cliLista = await trpc("query", "recolecciones.listar", {}, clienteToken);
      expect(cliLista.ok).toBe(false);
      if (!cliLista.ok) expect(cliLista.status).toBe(403);
      const cliDetalle = await trpc("query", "recolecciones.detalle", { id: idFila }, clienteToken);
      expect(cliDetalle.ok).toBe(false);
      if (!cliDetalle.ok) expect(cliDetalle.status).toBe(403);

      // Agricultor AJENO: listar no entrega la fila del farmer fixture y el detalle es 403.
      const agroLista = await trpc<RecoleccionDto[]>(
        "query",
        "recolecciones.listar",
        {},
        agroToken,
      );
      expect(agroLista.ok).toBe(true);
      if (agroLista.ok) {
        expect(agroLista.data.some((r) => r.id === idFila)).toBe(false);
        // Every row delivered belongs to the caller (seed agricultor has none of the
        // per-run farmer's rows).
        for (const fila of agroLista.data) expect(fila.fkAgricultor).not.toBe(farmerId);
      }
      const agroDetalle = await trpc("query", "recolecciones.detalle", { id: idFila }, agroToken);
      expect(agroDetalle.ok).toBe(false);
      if (!agroDetalle.ok) expect(agroDetalle.status).toBe(403);
      const filtroAjeno = await trpc(
        "query",
        "recolecciones.listar",
        { fkAgricultor: farmerId },
        agroToken,
      );
      expect(filtroAjeno.ok).toBe(false);
      if (!filtroAjeno.ok) expect(filtroAjeno.status).toBe(403);

      // Agricultor no opera la agenda (legacy HasRole(ADMIN, VENDEDOR)).
      const agroCrea = await crearRecoleccion(
        { fkAgricultor: farmerId, fechaRecoleccion: "2027-06-21" },
        agroToken,
      );
      expect(agroCrea.ok).toBe(false);
      if (!agroCrea.ok) expect(agroCrea.status).toBe(403);

      // Vendedor/Admin ven la agenda completa: la fila nueva está en el listado.
      const vendLista = await trpc<RecoleccionDto[]>(
        "query",
        "recolecciones.listar",
        {},
        vendedorToken,
      );
      expect(vendLista.ok).toBe(true);
      if (vendLista.ok) expect(vendLista.data.some((r) => r.id === idFila)).toBe(true);
    },
    T,
  );

  test(
    "máquina de estados estricta: pendiente→recolectado futuro 400, mismo estado 400, transición válida OK",
    async () => {
      const res = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-22",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const idFila = res.data.id;

      // Salto directo futuro: no es transición válida (la excepción exige fecha pasada).
      const salto = await trpc(
        "mutation",
        "recolecciones.avanzar",
        { id: idFila, estado: "recolectado", version: res.data.version },
        vendedorToken,
      );
      expect(salto.ok).toBe(false);
      if (!salto.ok) {
        expect(salto.status).toBe(400);
        expect(salto.errorMessage).toBe("No se puede cambiar de 'pendiente' a 'recolectado'.");
      }

      // Mismo estado → 400 (contrato estricto legacy /estado/).
      const mismo = await trpc(
        "mutation",
        "recolecciones.avanzar",
        { id: idFila, estado: "pendiente", version: res.data.version },
        vendedorToken,
      );
      expect(mismo.ok).toBe(false);
      if (!mismo.ok) expect(mismo.errorMessage).toBe("La recolección ya está en ese estado.");

      // pendiente→en_ruta OK (version incrementada).
      const enRuta = await trpc<RecoleccionDto>(
        "mutation",
        "recolecciones.avanzar",
        { id: idFila, estado: "en_ruta", version: res.data.version },
        vendedorToken,
      );
      expect(enRuta.ok).toBe(true);
      if (!enRuta.ok) return;
      expect(enRuta.data.estado).toBe("en_ruta");
      expect(enRuta.data.version).toBe(res.data.version + 1);
    },
    T,
  );

  test(
    "CAS: avanzar con versión rancia → 409; con versión fresca funciona",
    async () => {
      const res = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-23",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // First advance moves the row to en_ruta behind the caller's back.
      await trpc<RecoleccionDto>(
        "mutation",
        "recolecciones.avanzar",
        { id: res.data.id, estado: "en_ruta", version: res.data.version },
        vendedorToken,
      );

      const rancia = await trpc(
        "mutation",
        "recolecciones.avanzar",
        { id: res.data.id, estado: "recolectado", version: res.data.version },
        vendedorToken,
      );
      expect(rancia.ok).toBe(false);
      if (!rancia.ok) expect(rancia.status).toBe(409);

      const fila = await pgUna<{ version: number }>(
        "select version from recoleccion where id = $1",
        [res.data.id],
      );
      const fresca = await trpc<RecoleccionDto>(
        "mutation",
        "recolecciones.avanzar",
        { id: res.data.id, estado: "recolectado", version: fila.version },
        vendedorToken,
      );
      expect(fresca.ok).toBe(true);
      if (fresca.ok) expect(fresca.data.estado).toBe("recolectado");
    },
    T,
  );

  test(
    "completado tardío (legacy B3): pendiente vencido → recolectado OK; pendiente vencido → en_ruta 400",
    async () => {
      const creada = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-24",
      });
      expect(creada.ok).toBe(true);
      if (!creada.ok) return;

      // Backdate the appointment via SQL (fixture-style setup write, pagos parity).
      await pgQuery("update recoleccion set fecha_recoleccion = $2 where id = $1", [
        creada.data.id,
        FECHA_PASADA,
      ]);

      const enRutaPasada = await trpc(
        "mutation",
        "recolecciones.avanzar",
        { id: creada.data.id, estado: "en_ruta", version: creada.data.version },
        vendedorToken,
      );
      expect(enRutaPasada.ok).toBe(false);
      if (!enRutaPasada.ok) {
        expect(enRutaPasada.status).toBe(400);
        expect(enRutaPasada.errorMessage).toBe(
          "La fecha de la recolección ya pasó; solo se permite cancelarla o marcarla como recolectada.",
        );
      }

      const tardia = await trpc<RecoleccionDto>(
        "mutation",
        "recolecciones.avanzar",
        { id: creada.data.id, estado: "recolectado", version: creada.data.version },
        vendedorToken,
      );
      expect(tardia.ok).toBe(true);
      if (tardia.ok) expect(tardia.data.estado).toBe("recolectado");

      // The historial records the real transition (pendiente → recolectado).
      const historial = await pgQuery<{ estado_anterior: string | null; estado_nuevo: string }>(
        "select estado_anterior, estado_nuevo from historial_estado_recoleccion where fk_recoleccion = $1 order by creado_en asc",
        [creada.data.id],
      );
      expect(historial.length).toBe(2);
      expect(historial[1]?.estado_anterior).toBe("pendiente");
      expect(historial[1]?.estado_nuevo).toBe("recolectado");
    },
    T,
  );

  test(
    "terminal: recolectado no admite cambios (400) y slot queda ocupado; Admin también opera",
    async () => {
      const res = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-25",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      await trpc<RecoleccionDto>(
        "mutation",
        "recolecciones.avanzar",
        { id: res.data.id, estado: "en_ruta", version: res.data.version },
        adminToken,
      );
      const recolectada = await trpc<RecoleccionDto>(
        "mutation",
        "recolecciones.avanzar",
        {
          id: res.data.id,
          estado: "recolectado",
          version: res.data.version + 1,
        },
        adminToken,
      );
      expect(recolectada.ok).toBe(true);

      const intento = await trpc(
        "mutation",
        "recolecciones.avanzar",
        {
          id: res.data.id,
          estado: "cancelado",
          version: res.data.version + 2,
        },
        vendedorToken,
      );
      expect(intento.ok).toBe(false);
      if (!intento.ok) {
        expect(intento.status).toBe(400);
        expect(intento.errorMessage).toBe("No se puede cambiar de 'recolectado' a 'cancelado'.");
      }

      // R1: the slot stays occupied after RECOLECTADO (legacy test_slot_ocupado_tras_recolectar).
      const dup = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-25",
      });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.errorMessage).toBe(MSG_DUPLICADO);
    },
    T,
  );

  test(
    "cancelar idempotente: 1ª cancela (historial+outbox), 2ª → 200 'ya estaba cancelada' sin efectos; slot liberado",
    async () => {
      const res = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-26",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const primera = await trpc<CancelarDto>(
        "mutation",
        "recolecciones.cancelar",
        { id: res.data.id, version: res.data.version },
        vendedorToken,
      );
      expect(primera.ok).toBe(true);
      if (!primera.ok) return;
      expect(primera.data.recoleccion.estado).toBe("cancelado");
      expect(primera.data.mensaje).toBe("Recolección cancelada correctamente.");

      const historialAntes = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from historial_estado_recoleccion where fk_recoleccion = $1",
          [res.data.id],
        )
      ).n;
      const filaAntes = await pgUna<{ version: number }>(
        "select version from recoleccion where id = $1",
        [res.data.id],
      );

      const segunda = await trpc<CancelarDto>(
        "mutation",
        "recolecciones.cancelar",
        { id: res.data.id, version: filaAntes.version },
        vendedorToken,
      );
      expect(segunda.ok).toBe(true);
      if (segunda.ok) {
        expect(segunda.data.mensaje).toBe("La recolección ya estaba cancelada.");
        expect(segunda.data.recoleccion.version).toBe(filaAntes.version);
      }

      const historialDespues = (
        await pgUna<{ n: number }>(
          "select count(*)::int n from historial_estado_recoleccion where fk_recoleccion = $1",
          [res.data.id],
        )
      ).n;
      expect(historialDespues).toBe(historialAntes);

      // R1: a CANCELLED row frees the slot — the same (agricultor, fecha) is bookable again.
      const reagenda = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-26",
      });
      expect(reagenda.ok).toBe(true);
      if (reagenda.ok) expect(reagenda.data.id).not.toBe(res.data.id);
    },
    T,
  );

  test(
    "cancelar con versión rancia → 409 y sin efectos (estado sin cambios)",
    async () => {
      const res = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-27",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const rancia = await trpc(
        "mutation",
        "recolecciones.cancelar",
        { id: res.data.id, version: res.data.version + 99 },
        vendedorToken,
      );
      expect(rancia.ok).toBe(false);
      if (!rancia.ok) expect(rancia.status).toBe(409);

      const fila = await pgUna<{ estado: string; version: number }>(
        "select estado, version from recoleccion where id = $1",
        [res.data.id],
      );
      expect(fila.estado).toBe("pendiente");
      expect(fila.version).toBe(res.data.version);
    },
    T,
  );

  test(
    "avanzar escribe outbox (recoleccion update + historial insert) en la misma tx",
    async () => {
      const res = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-06-28",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const enRuta = await trpc<RecoleccionDto>(
        "mutation",
        "recolecciones.avanzar",
        { id: res.data.id, estado: "en_ruta", version: res.data.version },
        vendedorToken,
      );
      expect(enRuta.ok).toBe(true);

      const outbox = await pgQuery<{ tabla_origen: string; operacion: string }>(
        "select tabla_origen, operacion from sync_cambio where (tabla_origen = 'recoleccion' and id_fila = $1) or (tabla_origen = 'historial_estado_recoleccion' and id_fila in (select id from historial_estado_recoleccion where fk_recoleccion = $1))",
        [res.data.id],
      );
      expect(outbox.some((o) => o.tabla_origen === "recoleccion" && o.operacion === "insert")).toBe(
        true,
      );
      expect(outbox.some((o) => o.tabla_origen === "recoleccion" && o.operacion === "update")).toBe(
        true,
      );
      expect(
        outbox.filter(
          (o) => o.tabla_origen === "historial_estado_recoleccion" && o.operacion === "insert",
        ).length,
      ).toBe(2);
    },
    T,
  );

  test(
    "listar: DTO lleva localidad/municipio del agricultor (T22 agrupación por ubicación) — paridad SQL directa",
    async () => {
      // Own slot (fresh date) so the proof doesn't depend on earlier tests.
      const creada = await crearRecoleccion({
        fkAgricultor: farmerId,
        fechaRecoleccion: "2027-07-02",
      });
      expect(creada.ok).toBe(true);
      if (!creada.ok) return;

      const res = await trpc<RecoleccionDto[]>("query", "recolecciones.listar", {}, vendedorToken);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const propia = res.data.find((r) => r.id === creada.data.id);
      expect(propia).toBeDefined();
      if (!propia) return;

      // Direct-SQL expectation for the fixture farmer (persona → fk_localidad):
      // the persona was created with the Tepic localidad (crearAgricultorFixture).
      const esperado = await pgUna<{ localidad: string | null; municipio: string | null }>(
        `select l.nombre as "localidad", m.nombre as "municipio"
         from usuario u
         join persona p on p.id = u.fk_persona
         left join localidad l on l.id = p.fk_localidad
         left join municipio m on m.id = l.fk_municipio
         where u.id = $1`,
        [farmerId],
      );
      expect(esperado.localidad).toBe("Tepic");
      expect(propia.localidad).toBe(esperado.localidad);
      expect(propia.municipio).toBe(esperado.municipio);
    },
    T,
  );
});
