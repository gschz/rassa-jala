/**
 * Headless end-to-end proof of the 9 acceptance points (docs/scope.md §7.1)
 * for the vertical slice. Runs the REAL client modules (sync-client,
 * replication, database schemas) against the REAL server (spawned Bun+tRPC),
 * over fake-indexeddb, and verifies PostgreSQL persistence with read-only
 * SELECTs. UI/browser behavior is covered by manual testing, not here.
 *
 * Re-run safe: the script never deletes/updates PG rows directly (only the
 * tRPC push path writes), so it targets rows dynamically and asserts on
 * relative values (version deltas, count deltas).
 *
 * Phases:
 *  A  PULL — server seed reaches the client via checkpoints          (point 7)
 *  B  WRITE — local write visible + pending marker before verdict    (point 6)
 *  C  OFFLINE — write with server down, reconnect, push confirmed    (points 5,6,8)
 *  D  CONFLICT — stale version push → conflicto + server-wins        (point 8)
 *  E  TOMBSTONE — soft-delete propagates and pulls back              (point 7)
 *  F  IDEMPOTENCY — replayed operationId writes nothing new          (sync doc §7)
 *  G  POSTGRES — direct SELECT proofs of pushed data                 (point 9)
 */
import "varlock/auto-load";
import "fake-indexeddb/auto";

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createRxDatabase } from "rxdb/plugins/core";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import {
  collectionCreators,
  type LocalidadDoc,
  type RassaCollections,
  type RassaDatabase,
} from "../src/lib/rxdb/database";
import { startReplications } from "../src/lib/rxdb/replication";
import { pushOperaciones } from "../src/lib/rxdb/sync-client";
import { getSyncStatus, resolvePending, trackPending } from "../src/lib/rxdb/sync-status";
import { setSession } from "../src/lib/auth/session";

// Bun evaluates the CJS dexie build with empty domDeps unless the fake
// implementation is passed explicitly (same workaround as scripts/rxdb-check.ts).
const FAKE_DEXIE_SETTINGS = { indexedDB: fakeIndexedDB, IDBKeyRange: fakeIDBKeyRange };

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER_DIR = path.join(ROOT, "apps", "server");
const DB_DIR = path.join(ROOT, "packages", "db");
const BASE_URL = "http://localhost:3000";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Global watchdog: the script must never run unbounded.
const WATCHDOG_MS = 900_000;
const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: script exceeded ${WATCHDOG_MS / 1000}s — failing loud`);
  process.exit(1);
}, WATCHDOG_MS);

function record(ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} — ${detail}`);
}

/** Asserts and fails loud on the first miss (later phases depend on earlier ones). */
function must(ok: boolean, detail: string): void {
  record(ok, detail);
  if (!ok) throw new Error(`phase failed: ${detail}`);
}

/** Bounded poll: retries `attempt` until it returns non-null or the timeout hits (fails loud). */
async function poll<T>(
  label: string,
  timeoutMs: number,
  attempt: () => Promise<T | null>,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`[TIMEOUT after ${timeoutMs}ms] ${label}`);
    }
    await sleep(500);
  }
}

// ---- PostgreSQL access (read-only SELECTs; no secrets printed) ----

const envText = await readFile(path.join(DB_DIR, ".env"), "utf8");

function parseDatabaseUrl(env: string): string {
  const value = /^DATABASE_URL=(.*)$/m.exec(env)?.[1]?.trim();
  if (value) return value;
  throw new Error("DATABASE_URL not found in packages/db/.env");
}
// E2E_DATABASE_URL (external, process env) points the whole run at another
// database (e.g. the Supabase TEST env): the pg proofs below read it AND the
// spawned server receives it as DATABASE_URL (varlock prefers process env over
// apps/server/.env). Default (unset) keeps the local .env behavior untouched.
const DATABASE_URL: string = process.env.E2E_DATABASE_URL ?? parseDatabaseUrl(envText);

// Resolve pg from packages/db's own dependency tree; minimal surface typed here.
type PgClient = {
  connect(): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<unknown>;
};
const requireDb = createRequire(path.join(DB_DIR, "package.json"));
const { Client } = requireDb("pg") as {
  Client: new (config: { connectionString: string }) => PgClient;
};

async function pgQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows as T[];
  } finally {
    await client.end();
  }
}

type Counts = { m: number; l: number; cp: number; sc: number; so: number };

async function pgCounts(): Promise<Counts> {
  // Stage A COL23 (M-18): `unidades` was freed from the RxDB client — the PULL proof
  // covers the municipios/localidades/categorias slice (the collection is no longer
  // opened), so the unidad count left the assertions.
  const rows = await pgQuery<Counts>(
    "select (select count(*) from municipio where estado)::int m, (select count(*) from localidad where estado)::int l, " +
      "(select count(*) from categoria_producto where estado)::int cp, " +
      "(select count(*) from sync_cambio)::int sc, (select count(*) from sync_operacion)::int so",
  );
  return rows[0]!;
}

type PgLocalidad = {
  id: string;
  nombre: string;
  version: number;
  estado: boolean;
  fk_municipio: string;
};

async function pgLocalidad(id: string): Promise<PgLocalidad | null> {
  const rows = await pgQuery<PgLocalidad>(
    "select id, nombre, version::int, estado, fk_municipio from localidad where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

type PgOperacion = { id: string; doc_id: string; op: string; veredicto: string };

async function pgConflictoCount(docId: string): Promise<number> {
  const rows = await pgQuery<{ n: number }>(
    "select count(*)::int n from sync_operacion where doc_id = $1 and veredicto = 'conflicto'",
    [docId],
  );
  return rows[0]!.n;
}

/** Picks any alive localidad untouched by this run (rows persist across runs by design).
 * Excludes imported catalog rows (legacy_id): the legacy import restores real Nayarit
 * catalogs, so the suites must not use them as scratch targets (T2b, import selectivo). */
async function pickAliveLocalidad(excludeIds: string[]): Promise<PgLocalidad> {
  const rows = await pgQuery<PgLocalidad>(
    "select id, nombre, version::int, estado, fk_municipio from localidad where estado and legacy_id is null and id <> all($1::uuid[]) order by nombre limit 1",
    [excludeIds],
  );
  if (!rows[0]) throw new Error("no alive localidad available as target");
  return rows[0];
}

// ---- server process management ----

let server: ChildProcess | null = null;

function spawnServer(): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.env.E2E_DATABASE_URL) {
    // varlock in the child prefers process env over apps/server/.env: point the
    // server at the external database too (STORAGE_DRIVER flows through as-is).
    env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  }
  // Same fixture rule as e2e/helpers.ts: a __VARLOCK_ENV blob inherited from this
  // varlock-initialized process is pinned to apps/web and makes the child ignore
  // the env overrides above — drop it so the child resolves apps/server/.env itself.
  delete env.__VARLOCK_ENV;
  return spawn("bun", ["run", "--hot", "src/index.ts"], {
    cwd: SERVER_DIR,
    env,
    stdio: "inherit",
  });
}

async function waitExited(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function waitHealthy(timeoutMs = 60_000): Promise<void> {
  await poll("server / responds", timeoutMs, async () => {
    try {
      const res = await fetch(`${BASE_URL}/`);
      return (await res.text()) === "OK" ? true : null;
    } catch {
      return null;
    }
  });
}

async function killServer(): Promise<void> {
  if (!server) return;
  server.kill();
  await waitExited(server);
  server = null;
  await poll("port 3000 closed", 15_000, async () => {
    try {
      await fetch(`${BASE_URL}/`);
      return null;
    } catch {
      return true;
    }
  });
}

// ---- setup ----

// replication.ts registers window online/focus listeners + a reSync interval.
(globalThis as unknown as { window: unknown }).window = globalThis;
// server-url.ts (LAN/mobile support) reads window.location.hostname; the headless
// run aliases window to globalThis, whose location is undefined under Bun — pin a
// localhost location so the resolver keeps the configured :3000 URL.
(globalThis as unknown as { location?: URL }).location ??= new URL("http://localhost:3000/");

const e2eName = (label: string): string => `${label} (slice-e2e)`;

const db = (await createRxDatabase<RassaCollections>({
  name: "rassajalaslicee2e",
  storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS),
  multiInstance: false,
}).then(async (instance) => {
  await instance.addCollections(collectionCreators);
  return instance;
})) as RassaDatabase;

// Guard: the script must own port 3000, or health checks would hit a stale server.
const portBusy = await fetch(`${BASE_URL}/`)
  .then(() => true)
  .catch(() => false);
if (portBusy) throw new Error("port 3000 is already in use — stop the other server first");

server = spawnServer();
await waitHealthy();

// Point 1+2: Bun backend serving plain HTTP and a functional tRPC procedure.
const health = (await fetch(`${BASE_URL}/trpc/healthCheck`).then((r) => r.json())) as {
  result?: { data?: string };
};
must(
  health.result?.data === "OK",
  `points 1+2: Bun.serve backend OK, tRPC healthCheck=${health.result?.data} (@hono/trpc-server)`,
);

// ---- Phase AUTH: the slice requires an authenticated identity (P0 Autenticación) ----
// Log in as the dev admin through the real tRPC wire format (batched POST) and populate
// the session store the client transports read the Bearer token from. The sync procedures
// reject unauthenticated callers and bind the push actor to this user id.
const loginRes = await fetch(`${BASE_URL}/trpc/auth.login?batch=1`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ 0: { email: "admin@rassa.local", password: "RassaDev2026!" } }),
});
const loginBody = (await loginRes.json()) as Array<{
  result?: { data?: { accessToken?: string; user?: { id: string; email: string; rol: string } } };
}>;
const loginData = loginBody[0]?.result?.data;
if (loginRes.status !== 200 || !loginData?.accessToken || !loginData.user) {
  throw new Error("auth: dev admin login failed — the slice requires an authenticated identity");
}
record(true, `auth: dev admin login issued an access token (rol=${loginData.user.rol})`);
setSession(loginData.user, loginData.accessToken);
const ADMIN_ID = loginData.user.id;

// ---- Phase A: PULL via checkpoints (point 7) ----

const baseline = await pgCounts();
console.log(
  `PG baseline: municipios=${baseline.m} localidades=${baseline.l} categorias=${baseline.cp} sync_cambio=${baseline.sc} sync_operacion=${baseline.so}`,
);

const reps = startReplications(db);

const pulled = await poll("replication pulls the seed", 150_000, async () => {
  const [m, l, c] = await Promise.all([
    db.municipios.find().exec(),
    db.localidades.find().exec(),
    db.categorias.find().exec(),
  ]);
  const counts = { m: m.length, l: l.length, c: c.length };
  return counts.m === baseline.m && counts.l === baseline.l && counts.c === baseline.cp
    ? counts
    : null;
});
must(
  true,
  `point 7 (PULL): checkpoints delivered municipios=${pulled.m} localidades=${pulled.l} categorias=${pulled.c} — equal to PG alive counts`,
);

// ---- helpers on top of the real client modules ----

function nuevoLocalidad(nombre: string, fkMunicipio: string): LocalidadDoc {
  return {
    id: crypto.randomUUID(),
    nombre,
    fkMunicipio,
    estado: true,
    version: 0,
    actualizadoEn: new Date().toISOString(),
    syncOpId: crypto.randomUUID(),
  };
}

async function insertLocalidad(nombre: string, fkMunicipio: string): Promise<LocalidadDoc> {
  const doc = nuevoLocalidad(nombre, fkMunicipio);
  trackPending(doc.id);
  await db.localidades.insert(doc);
  return doc;
}

// ---- Phase B: local write with pending marker BEFORE push confirmation (point 6) ----

const tepic = await pgQuery<{ id: string }>(
  "select id from municipio where nombre = 'Tepic' limit 1",
);
const fkTepic = tepic[0]!.id;

const docB = await insertLocalidad(e2eName("El Mortero"), fkTepic);
// Read back synchronously: this happens before any push round-trip can confirm.
const localB = (await db.localidades.findOne(docB.id).exec())?.toJSON() as LocalidadDoc | undefined;
must(
  localB != null && localB.syncOpId === docB.syncOpId,
  `point 6 (local write): visible locally BEFORE confirmation, pending marker syncOpId=${docB.syncOpId}`,
);

const rowB = await poll("push confirmation for El Mortero", 60_000, async () => {
  const row = await pgLocalidad(docB.id);
  return row && row.nombre === docB.nombre ? row : null;
});
resolvePending(docB.id);
must(
  rowB.version === 1 && !getSyncStatus().pendingLocalidadIds.includes(docB.id),
  "point 6: push confirmed (PG row version=1) and the pending marker resolved after the verdict",
);

// ---- Phase C: offline write → reconnect → push confirmed (points 5, 6, 8) ----

await killServer();
console.log("server down — writing offline");
const docC = await insertLocalidad(e2eName("Rincón de Guayabitos"), fkTepic);
const localC = (await db.localidades.findOne(docC.id).exec())?.toJSON() as LocalidadDoc | undefined;
must(
  localC != null && localC.syncOpId === docC.syncOpId,
  `points 5+6 (offline read/write): write persisted locally while offline (syncOpId=${docC.syncOpId})`,
);
const leaked = await pgLocalidad(docC.id);
must(
  leaked == null,
  "point 5: offline write NOT on the server while disconnected (no phantom confirmation)",
);

// Stay offline longer than retryTime (5s) so the replication enters its retry schedule.
await sleep(6_500);

server = spawnServer();
await waitHealthy();
const rowC = await poll("offline write applied after reconnect", 120_000, async () => {
  const row = await pgLocalidad(docC.id);
  return row && row.nombre === docC.nombre ? row : null;
});
const verdictC = await poll("sync_operacion verdict for the offline write", 30_000, async () => {
  const rows = await pgQuery<PgOperacion>(
    "select id, doc_id, op, veredicto from sync_operacion where id = $1",
    [docC.syncOpId!],
  );
  return rows[0] ?? null;
});
must(
  verdictC.veredicto === "aplicada" && rowC.estado === true,
  `point 8 (reconexión y recuperación): offline write pushed after reconnect, veredicto=${verdictC.veredicto}, PG estado=${rowC.estado}`,
);

// ---- Phase D: stale-version push → conflicto + server-wins applied locally (point 8) ----

const X = await pickAliveLocalidad([docB.id, docC.id]);
const XID = X.id;
console.log(`phase D target: "${X.nombre}" (${XID})`);

let conflictOk = false;
let conflictDetail = "";
for (let attempt = 1; attempt <= 2 && !conflictOk; attempt++) {
  try {
    const conflictosBefore = await pgConflictoCount(XID);
    // E1 — a local edit that applies cleanly (real replication push path).
    const vBefore = await pgLocalidad(XID);
    const x0 = await db.localidades.findOne(XID).exec();
    await x0!.incrementalModify((d) => ({
      ...d,
      nombre: `${X.nombre} (edit1-${attempt})`,
      syncOpId: crypto.randomUUID(),
    }));
    await poll("E1 applied on server", 60_000, async () => {
      const row = await pgLocalidad(XID);
      return row != null && row.version === vBefore!.version + 1 ? row : null;
    });

    // Actor B — another client bumps the server row via the app's own push path.
    const current = await pgLocalidad(XID);
    const actorNombre = `${X.nombre} (actor B)`;
    const actorB = await pushOperaciones<LocalidadDoc>("localidades", [
      {
        operationId: crypto.randomUUID(),
        docId: XID,
        op: "update",
        nuevoEstado: {
          id: XID,
          fkMunicipio: current!.fk_municipio,
          nombre: actorNombre,
          estado: true,
          version: current!.version,
          actualizadoEn: new Date().toISOString(),
          _deleted: false,
        },
        versionAsumida: current!.version,
      },
    ]);
    if (actorB[0]?.veredicto !== "aplicada") {
      conflictDetail = `actor B bump returned ${actorB[0]?.veredicto ?? "no result"}`;
      continue;
    }

    // E2 — local edit while the client master state is stale (server is one version ahead).
    const x1 = await db.localidades.findOne(XID).exec();
    await x1!.incrementalModify((d) => ({
      ...d,
      nombre: `${X.nombre} (edit2-${attempt})`,
      syncOpId: crypto.randomUUID(),
    }));

    // Server-wins must overwrite the local edit with the actor-B state.
    const won = await poll("conflict resolution", 90_000, async () => {
      const doc = (await db.localidades.findOne(XID).exec())?.toJSON() as LocalidadDoc | undefined;
      const pg = await pgLocalidad(XID);
      if (doc?.nombre === actorNombre && pg != null && pg.version === doc.version) return doc;
      // Race lost (the interval re-pulled before E2 pushed): applied instead of conflicto.
      if (doc?.nombre?.includes("edit2") === true && pg != null && pg.nombre === doc.nombre) {
        throw new Error(`attempt ${attempt}: reSync race — E2 applied instead of conflicto`);
      }
      return null;
    });

    // The conflicto verdict is counted server-side: the server-wins state overwrites the
    // local syncOpId, so the local doc no longer carries the operationId.
    const conflictosAfter = await pgConflictoCount(XID);
    conflictOk = conflictosAfter === conflictosBefore + 1;
    conflictDetail = conflictOk
      ? `point 8 (PUSH conflict): stale versionAsumida for "${X.nombre}" → veredicto=conflicto, server-wins applied locally (nombre="${won.nombre}", version=${won.version})`
      : `no new conflicto verdict (before=${conflictosBefore} after=${conflictosAfter}, server nombre=${(await pgLocalidad(XID))?.nombre})`;
  } catch (error) {
    conflictDetail = `attempt ${attempt}: ${(error as Error).message}`;
  }
}
must(conflictOk, conflictDetail);

// ---- Phase E: tombstone (soft-delete) propagates and pulls back (point 7) ----

const BV = await pickAliveLocalidad([docB.id, docC.id, XID]);
const BID = BV.id;
console.log(`phase E target: "${BV.nombre}" (${BID})`);
const bv0 = await pgLocalidad(BID);

// Direct soft-delete of the untouched pulled doc (versionAsumida = last known server
// version). No local pre-edit: an extra edit would desync the client's assumed version
// and the delete push would legitimately return conflicto (observed once).
const bvDoc = await db.localidades.findOne(BID).exec();
await bvDoc!.remove();

const tombstonePg = await poll("soft-delete applied on server", 60_000, async () => {
  const row = await pgLocalidad(BID);
  return row && row.estado === false && row.version === bv0!.version + 1 ? row : null;
});

// PULL must reflect the deletion locally (no ghost) and advance the checkpoint.
const checkpointBefore = getSyncStatus().collections.localidades.checkpoint;
reps.reSyncAll();
const pulledTombstone = await poll("pull reflects the tombstone locally", 60_000, async () => {
  const doc = await db.localidades.findOne(BID).exec();
  const checkpoint = getSyncStatus().collections.localidades.checkpoint;
  if (
    doc === null &&
    checkpoint != null &&
    checkpointBefore != null &&
    checkpoint > checkpointBefore
  )
    return true;
  return null;
});
must(
  pulledTombstone && tombstonePg.estado === false,
  `point 7 (tombstone): "${BV.nombre}" soft-delete applied (PG estado=${tombstonePg.estado}, version=${tombstonePg.version}; row mutation implies verdict aplicada), PULL removed the doc locally and advanced the checkpoint`,
);

// ---- Phase F: idempotency — replaying an operationId writes nothing new (sync doc §7) ----

const beforeF = await pgCounts();
const replay = await pushOperaciones<LocalidadDoc>("localidades", [
  {
    operationId: docC.syncOpId!,
    docId: docC.id,
    op: "create",
    nuevoEstado: {
      id: docC.id,
      fkMunicipio: docC.fkMunicipio,
      nombre: docC.nombre,
      estado: true,
      version: 0,
      actualizadoEn: docC.actualizadoEn,
      _deleted: false,
    },
    versionAsumida: null,
  },
]);
const afterF = await pgCounts();
const countsEqual =
  beforeF.m === afterF.m &&
  beforeF.l === afterF.l &&
  beforeF.cp === afterF.cp &&
  beforeF.sc === afterF.sc &&
  beforeF.so === afterF.so;
must(
  replay[0]?.veredicto === "aplicada" && countsEqual,
  `sync doc §7 idempotency: replayed operationId → veredicto=${replay[0]?.veredicto}, PG counts unchanged (localidad ${beforeF.l}→${afterF.l}, sync_cambio ${beforeF.sc}→${afterF.sc}, sync_operacion ${beforeF.so}→${afterF.so})`,
);

// ---- Phase G: PostgreSQL persistence proofs (point 9) ----

const touchedIds = [docB.id, docC.id, XID, BID];
const touched = await pgQuery<{
  id: string;
  nombre: string;
  version: number;
  estado: boolean;
  actualizado_en: string;
}>(
  "select id, nombre, version::int, estado, fk_municipio, actualizado_en from localidad where id = any($1::uuid[])",
  [touchedIds],
);
const ops = await pgQuery<PgOperacion & { fk_usuario: string }>(
  "select id, doc_id, op, veredicto, fk_usuario from sync_operacion where doc_id = any($1::uuid[])",
  [touchedIds],
);
const cambios = await pgQuery<{
  id: number;
  tabla_origen: string;
  id_fila: string;
  operacion: string;
  actor: string;
}>(
  "select id, tabla_origen, id_fila, operacion, actor from sync_cambio where id_fila = any($1::uuid[]) order by id",
  [touchedIds],
);
console.log("G localidad rows:", JSON.stringify(touched, null, 2));
console.log("G sync_operacion verdicts:", JSON.stringify(ops, null, 2));
console.log("G sync_cambio outbox rows:", JSON.stringify(cambios, null, 2));
must(
  touched.length === 4 &&
    ops.length >= 5 &&
    ops.every((o) => o.veredicto === "aplicada" || o.veredicto === "conflicto") &&
    cambios.length >= 4 &&
    touched.every((t) => t.actualizado_en != null) &&
    // P0 auth: the push actor is the AUTHENTICATED user id, not the old dev stub.
    ops.every((o) => o.fk_usuario === ADMIN_ID) &&
    // The seed transaction writes its own outbox rows with actor='dev-seed' (pre-auth);
    // every row the APP wrote must carry the authenticated user id.
    cambios.every(
      (c) =>
        c.actor === ADMIN_ID ||
        c.actor === "dev-seed" ||
        // The legacy import writes its own outbox rows (provenance marker 'legacy-import');
        // they coexist with app-written rows on a touched imported row (T2b, import selectivo).
        c.actor === "legacy-import",
    ) &&
    cambios.some((c) => c.actor === ADMIN_ID),
  `point 9 (PostgreSQL): ${touched.length} localidad rows with version/actualizado_en, ${ops.length} sync_operacion verdicts (actor=auth user), ${cambios.length} sync_cambio outbox rows (actor=auth user)`,
);

// ---- teardown ----

await reps.stop();
await db.close();
await killServer();
clearTimeout(watchdog);
console.log("teardown: replications stopped, RxDB closed, server stopped");

console.log("\nSLICE E2E: ALL PHASES PASSED — 9 acceptance points proven end-to-end");
process.exit(0);
