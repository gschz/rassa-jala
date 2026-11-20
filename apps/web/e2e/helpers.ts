/**
 * Shared headless e2e infrastructure (P0-INF reconstruction of the lost
 * /tmp/opencode suites). Conventions:
 * - ONE test server for the whole `bun test` process: apps/server spawned on an
 *   isolated port with a test-only STORAGE_LOCAL_DIR, started lazily by the
 *   first suite that needs it and killed on process exit.
 * - tRPC v11 batched wire format (verified): queries GET
 *   `?batch=1&input={"0":{...}}`, mutations POST `?batch=1` with body
 *   `{"0":{...}}`; pull procedures take the input key `limite`.
 * - PostgreSQL access is READ-ONLY for proofs (SELECT via packages/db's own pg).
 *   The only SQL writes are the fixed-id test fixtures below (upserts) and
 *   madurarOutbox() (test-only timing knob), mirroring the previous suites'
 *   established pattern (dev DB `rassa_jala_db_v2`).
 * - Re-run safe ×2: suites create their own data with dynamic suffixes; the
 *   SQL fixtures upsert fixed-id rows; stock/counts are asserted as deltas.
 * - Outbox gap window: interleaved sync_cambio rows can delay per-collection
 *   PULL delivery ~60 s (normative §4.2) — every PULL proof polls with a
 *   bounded deadline instead of assuming instant delivery.
 */
import "./helpers-varlock";

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  pullBatch,
  pushOperaciones,
  type Coleccion,
  type PushOperacion,
} from "../src/lib/rxdb/sync-client";
import { setSession } from "../src/lib/auth/session";

/**
 * The sync client authenticates through `authFetch`, which reads the Bearer token
 * from the session store (there is no token parameter in pullBatch/pushOperaciones).
 * Every PULL/PUSH helper below therefore points the store at the caller's token
 * first — otherwise the call silently runs as whoever logged in last.
 */
export function usarToken(token: string): void {
  setSession({ id: "", email: "", rol: "" }, token);
}

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER_DIR = path.join(ROOT, "apps", "server");
const DB_DIR = path.join(ROOT, "packages", "db");

// Test-side constant. The server entry already honors `process.env.PORT`
// (apps/server/src/index.ts) — no server change needed; the child is spawned
// with PORT=TEST_PORT. 3010 keeps clear of slice-e2e, which owns :3000.
export const TEST_PORT = 3010;
export const BASE_URL = `http://localhost:${TEST_PORT}`;
export const TRPC_URL = `${BASE_URL}/trpc`;
// Keeps repo `storage/` clean: the server stores uploaded images here when
// spawned with STORAGE_LOCAL_DIR (process env wins over the .env value).
export const STORAGE_TEST_DIR = "/tmp/opencode/storage-test";

export const AGRO = "agricultor@rassa.local";
export const AGRO2 = "agricultor2@rassa.local";
export const VENDEDOR = "vendedor@rassa.local";
export const VENDEDOR2 = "e2e-vendedor2@fixture.local";
export const CLIENTE = "cliente@rassa.local";
export const ADMIN = "admin@rassa.local";
export const BLOQUEADO = "bloqueado@rassa.local";
export const DEV_PASSWORD = "RassaDev2026!";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const sufijo = (): string =>
  `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// ---- server fixture (process-wide singleton) ----

let serverPromise: Promise<void> | null = null;
let serverChild: ChildProcess | null = null;

/**
 * Teardown hang (root cause, verified on bun 1.4.4):
 * 1. The spawned server inherited the test process's stdio, so `bun test | tail`
 *    never saw EOF after the run finished (the child held the pipe open) and no
 *    output was ever flushed.
 * 2. `bun test` never runs `process.on("exit")` / `beforeExit`, so exit hooks
 *    cannot kill the child; the unref'd child then survives as an orphan and the
 *    next run finds :3010 busy.
 * Fix: log the child to a FILE (never inherit the pipes), unref the handle, and
 * stop it from the global `afterAll` in preload.ts (wired by bunfig.toml).
 */
function killServer(): void {
  const child = serverChild;
  serverChild = null;
  if (!child) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** Stops the fixture server; the next ensureServer() spawns a fresh one. */
export function stopServer(): void {
  killServer();
  serverPromise = null;
}

let teardownRegistered = false;

function registerTeardown(): void {
  if (teardownRegistered) return;
  teardownRegistered = true;
  // Published for preload.ts (the only hook bun test actually runs).
  (globalThis as { __rassaE2EStopServer?: () => void }).__rassaE2EStopServer = stopServer;
  // Signal handlers still cover manual `bun run e2e/*.ts` runs and Ctrl-C.
  process.once("SIGINT", () => {
    killServer();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    killServer();
    process.exit(143);
  });
}

async function waitHealthy(deadlineMs = 45_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status === 200 && (await res.text()) === "OK") return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`test server on :${TEST_PORT} did not become healthy in ${deadlineMs}ms`);
    }
    await sleep(300);
  }
}

async function portAnswers(): Promise<boolean> {
  return fetch(`${BASE_URL}/`)
    .then(() => true)
    .catch(() => false);
}

async function spawnServer(): Promise<void> {
  // A previous file's server may still be closing its socket (the global
  // afterAll kills it right after the last test): give it a short grace period.
  const deadline = Date.now() + 5_000;
  while (await portAnswers()) {
    if (Date.now() > deadline) {
      throw new Error(
        `port ${TEST_PORT} already answers — a stale test server is running; kill it first (e.g. fuser -k ${TEST_PORT}/tcp)`,
      );
    }
    await sleep(200);
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(STORAGE_TEST_DIR, { recursive: true });
  const logFd = openSync(path.join(STORAGE_TEST_DIR, "server.log"), "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // PORT is the existing server knob (index.ts); STORAGE_LOCAL_DIR pins the
    // local storage driver away from the repo's storage/ dir.
    PORT: String(TEST_PORT),
    STORAGE_LOCAL_DIR: STORAGE_TEST_DIR,
  };
  // varlock (apps/server) inherits a `__VARLOCK_ENV` blob from this test
  // process when present; that blob is pinned to apps/web and lists only its
  // own override keys, so the child would ignore PORT/STORAGE_LOCAL_DIR.
  // Dropping the blob forces the child to resolve apps/server/.env itself.
  delete env.__VARLOCK_ENV;
  try {
    serverChild = spawn("bun", ["src/index.ts"], {
      cwd: SERVER_DIR,
      env,
      // File fd, NOT inherit: inheriting the test process pipes keeps them open
      // after the child outlives the run (see killServer note above).
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  registerTeardown();
  // Detach the handle from the event loop: bun test can then reach beforeExit.
  serverChild.unref();
  await waitHealthy();
}

/** Idempotent: the first caller spawns; every suite awaits the same server. */
export async function ensureServer(): Promise<void> {
  serverPromise ??= spawnServer();
  await serverPromise;
}

// ---- tRPC batched wire client ----

export type TrpcOk<T> = { ok: true; status: number; data: T };
export type TrpcErr = {
  ok: false;
  status: number;
  errorCode: string;
  errorMessage: string;
};
export type TrpcResult<T> = TrpcOk<T> | TrpcErr;

type BatchEntry = {
  result?: { data?: unknown };
  // tRPC v11 batched error entry: { message, code, data: { code, httpStatus } }.
  error?: { message?: string; data?: { code?: string } };
};

export async function trpc<T>(
  kind: "query" | "mutation",
  path: string,
  input?: unknown,
  token?: string | null,
  extraHeaders?: Record<string, string>,
): Promise<TrpcResult<T>> {
  await ensureServer();
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  if (kind === "query") {
    const inputJson = encodeURIComponent(JSON.stringify({ 0: input ?? null }));
    res = await fetch(`${TRPC_URL}/${path}?batch=1&input=${inputJson}`, { headers });
  } else {
    headers["content-type"] = "application/json";
    res = await fetch(`${TRPC_URL}/${path}?batch=1`, {
      method: "POST",
      headers,
      body: JSON.stringify({ 0: input ?? null }),
    });
  }
  const body = (await res.json()) as BatchEntry[];
  const entry = body[0];
  if (res.status >= 200 && res.status < 300 && entry?.result) {
    return { ok: true, status: res.status, data: entry.result.data as T };
  }
  const error = entry?.error;
  return {
    ok: false,
    status: res.status,
    errorCode: error?.data?.code ?? `HTTP_${res.status}`,
    errorMessage: error?.message ?? JSON.stringify(body).slice(0, 300),
  };
}

/** Setup-step helper: throws with the server error when a call must succeed. */
export async function must<T>(
  kind: "query" | "mutation",
  path: string,
  input?: unknown,
  token?: string | null,
): Promise<T> {
  const res = await trpc<T>(kind, path, input, token);
  if (!res.ok) {
    throw new Error(`must(${path}) failed ${res.status} ${res.errorCode}: ${res.errorMessage}`);
  }
  return res.data;
}

// ---- auth helpers ----

export type Sesion = {
  token: string;
  user: { id: string; email: string; rol: string; debeCambiarPassword?: boolean };
  /** httpOnly refresh cookie value ("name=value") when the response set one. */
  refreshCookie?: string;
};

type SesionRespuesta = {
  accessToken: string;
  user: { id: string; email: string; rol: string; debeCambiarPassword?: boolean };
};

function extraerRefreshCookie(cookies: string[]): string | undefined {
  const raw = cookies.find((c) => c.startsWith("rassa_refresh="));
  return raw ? raw.split(";")[0] : undefined;
}

export async function login(email: string, password: string): Promise<Sesion> {
  const res = await fetch(`${TRPC_URL}/auth.login?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ 0: { email, password } }),
  });
  const body = (await res.json()) as BatchEntry[];
  const data = body[0]?.result?.data as SesionRespuesta | undefined;
  if (!res.ok || !data?.accessToken) {
    const err = body[0]?.error;
    throw new Error(
      `login(${email}) failed: ${res.status} ${err?.data?.code ?? ""} ${err?.message ?? ""}`,
    );
  }
  const ses: Sesion = {
    token: data.accessToken,
    user: data.user,
    refreshCookie: extraerRefreshCookie(res.headers.getSetCookie()),
  };
  // The production sync-client (pullBatch/pushOperaciones via authFetch) reads the Bearer
  // token from the session store, not from a parameter — populate it on every login so
  // PULL/PUSH helpers authenticate exactly like the app does (slice-e2e pattern).
  setSession(ses.user, ses.token);
  return ses;
}

/** Silent variant that returns null instead of throwing (for negative proofs). */
export async function loginO(email: string, password: string): Promise<Sesion | null> {
  try {
    return await login(email, password);
  } catch {
    return null;
  }
}

export async function tokenDe(email: string, password: string): Promise<string> {
  return (await login(email, password)).token;
}

// ---- PostgreSQL access (fixtures write; proofs SELECT) ----

type PgClient = {
  connect(): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<unknown>;
};

const envText = await readFile(path.join(DB_DIR, ".env"), "utf8");
const DATABASE_URL = (/^DATABASE_URL=(.*)$/m.exec(envText)?.[1]?.trim() ?? "") as string;
if (!DATABASE_URL) throw new Error("DATABASE_URL not found in packages/db/.env");

const requireDb = createRequire(path.join(DB_DIR, "package.json"));
const { Client } = requireDb("pg") as {
  Client: new (config: { connectionString: string }) => PgClient;
};

export async function pgQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

export async function pgUna<T>(sql: string, params: unknown[] = []): Promise<T> {
  const rows = await pgQuery<T>(sql, params);
  if (rows.length === 0) throw new Error(`pgUna: no row for ${sql.slice(0, 80)}`);
  return rows[0] as T;
}

/** Latest sync_cambio seq for a table (the exact pre-mutation PULL checkpoint). */
export async function maxSeq(tabla: string): Promise<number> {
  const { mx } = await pgUna<{ mx: number }>(
    "select coalesce(max(id), 0)::int mx from sync_cambio where tabla_origen = $1",
    [tabla],
  );
  return mx;
}

// ---- PULL helpers (tolerate the outbox gap window) ----

export const PULL_DEADLINE_MS = 90_000;

/**
 * Test-only timing knob for PULL proofs. The server only advances the checkpoint
 * over a contiguous seq prefix of the rows VISIBLE to the caller; rows of other
 * tables (or other users) occupy the seqs in between, so a scoped collection can
 * wait the real GAP_WINDOW_MS (60 s) before its first row is delivered. Backdating
 * the outbox rows past the checkpoint makes delivery deterministic: the proof is
 * WHAT arrives (scoping, tombstones, propagation), not the wait. Delivery
 * correctness is still asserted through the deadline poll below.
 */
export async function madurarOutbox(checkpoint: number | null): Promise<void> {
  if (checkpoint == null) return;
  await pgQuery("update sync_cambio set creado_en = now() - interval '2 minutes' where id > $1", [
    checkpoint,
  ]);
}

/** One batched pull call (checkpoint = last delivered seq, null = from zero). */
export async function pullUna<TDoc>(
  coleccion: Coleccion,
  checkpoint: number | null,
  token: string,
): Promise<{ documentos: TDoc[]; checkpoint: number | null }> {
  usarToken(token);
  const res = await pullBatch<TDoc>(
    coleccion,
    checkpoint == null ? null : { seq: checkpoint },
    200,
  );
  return { documentos: res.documentos, checkpoint: res.checkpoint?.seq ?? checkpoint };
}

/** sync.{coleccion}.push as `token` (same session-store caveat as pullUna). */
export async function pushComo<TDoc>(
  coleccion: Coleccion,
  operaciones: PushOperacion<TDoc>[],
  token: string,
): Promise<Awaited<ReturnType<typeof pushOperaciones<TDoc>>>> {
  usarToken(token);
  return pushOperaciones<TDoc>(coleccion, operaciones);
}

/**
 * Polls the collection PULL until `predicado` holds, FOLLOWING the server
 * checkpoint and accumulating docs by id — exactly what the RxDB replication
 * handler does. Following the checkpoint is required for scoped collections:
 * the server only advances over a contiguous seq prefix of the visible outbox
 * rows, so a fixed checkpoint can stall on a gap forever (the interleaved
 * outbox rows of other tables / other users are never delivered to this one).
 */
export async function pullHasta<TDoc extends { id: string }>(
  coleccion: Coleccion,
  checkpoint: number | null,
  token: string,
  predicado: (docs: TDoc[]) => boolean,
  deadlineMs = PULL_DEADLINE_MS,
): Promise<TDoc[]> {
  const start = Date.now();
  const vistos = new Map<string, TDoc>();
  let cp = checkpoint;
  let ultimoTamano = 0;
  await madurarOutbox(checkpoint);
  for (;;) {
    const pagina = await pullUna<TDoc>(coleccion, cp, token);
    if (process.env.E2E_PULL_DEBUG) {
      console.log(
        `[pull ${coleccion}] ${cp} -> ${pagina.checkpoint} (${pagina.documentos.length})`,
      );
    }
    for (const doc of pagina.documentos) vistos.set(doc.id, doc);
    const docs = [...vistos.values()];
    ultimoTamano = pagina.documentos.length;
    if (predicado(docs)) return docs;
    if (Date.now() - start > deadlineMs) {
      throw new Error(
        `[PULL TIMEOUT ${deadlineMs}ms] ${coleccion} desde checkpoint ${checkpoint}: predicate not met (${vistos.size} docs acumulados, ${ultimoTamano} en la última página)`,
      );
    }
    cp = pagina.checkpoint ?? cp;
    await sleep(700);
  }
}

// ---- SQL fixtures (fixed ids, upserts; the ONLY SQL writes) ----

export type Fixture = {
  farmerId: string;
  pubActualId: string;
  itemActualId: string;
  pubPastId: string;
  itemPastId: string;
  /** precio 10.13, stock 1000 — the exact-money proof item (pedidos). */
  itemMoneyId: string;
  /** precio 10.13, stock 1000 — 2nd line of the 60.78/9.72/70.50 money proof. */
  itemMoney2Id: string;
  /** precio 10.13, stock 1000 — 3rd line of the 60.78/9.72/70.50 money proof. */
  itemMoney3Id: string;
  /** precio 5.00, stock 10 — the decrement/insufficient stock item (pedidos). */
  itemStockId: string;
  /** A SECOND farmer's published current-ciclo publication (+item) for scoping. */
  farmer2Id: string;
  /** A second active Vendedor: the claim race needs two competing sellers. */
  vendedor2Id: string;
  pubOtroId: string;
  itemOtroId: string;
  qaActivoId: string;
  qaInactivoId: string;
  itemActualPrecio: string;
  seqPubActual: number;
  seqItemActual: number;
  seqPubPast: number;
  seqItemPast: number;
};

const IDS = {
  farmer: "e2ef0a00-0000-4000-8000-0000000000f1",
  persona: "e2ef0a00-0000-4000-8000-0000000000f2",
  farmer2: "e2ef0a00-0000-4000-8000-0000000000f3",
  persona2: "e2ef0a00-0000-4000-8000-0000000000f4",
  vendedor2: "e2ef0a00-0000-4000-8000-0000000000f5",
  personaVendedor2: "e2ef0a00-0000-4000-8000-0000000000f6",
  pubActual: "e2ef0a00-0000-4000-8000-0000000000b1",
  itemActual: "e2ef0a00-0000-4000-8000-0000000000b2",
  itemMoney: "e2ef0a00-0000-4000-8000-0000000000b5",
  itemMoney2: "e2ef0a00-0000-4000-8000-0000000000b9",
  itemMoney3: "e2ef0a00-0000-4000-8000-0000000000ba",
  itemStock: "e2ef0a00-0000-4000-8000-0000000000b6",
  pubOtro: "e2ef0a00-0000-4000-8000-0000000000b7",
  itemOtro: "e2ef0a00-0000-4000-8000-0000000000b8",
  pubPast: "e2ef0a00-0000-4000-8000-0000000000c1",
  itemPast: "e2ef0a00-0000-4000-8000-0000000000c2",
  qaActivo: "e2ef0a00-0000-4000-8000-0000000000d1",
  qaInactivo: "e2ef0a00-0000-4000-8000-0000000000d2",
} as const;

// iso-semana is a dependency-free subpath export (no Prisma pulled in).
let fixturePromise: Promise<Fixture> | null = null;

/**
 * Ensures the fixed-id business rows every suite may target: a fixture farmer
 * (SQL-provisioned, login NOT required) with a PUBLISHED current-ciclo
 * publication (+item) and a PUBLISHED past-ciclo one (+item) for the
 * "published current ciclo only" proofs, and two QA maestro productos for the
 * push suite. Upserts make re-runs converge; each first insertion also writes
 * its sync_cambio row (actor 'e2e-fixture') so PULL can deliver them.
 */
export async function ensureFixtures(): Promise<Fixture> {
  fixturePromise ??= (async (): Promise<Fixture> => {
    const { mondayOfBusinessWeek, aFechaCiclo } = await import("@rassa-jala/db/iso-semana");
    const lunes = aFechaCiclo(mondayOfBusinessWeek(new Date()));
    const lunesPasado = aFechaCiclo(new Date(parseFechaCicloMs(lunes) - 7 * 86_400_000));

    const localidad = await pgUna<{ id: string }>(
      "select id from localidad where nombre = 'Tepic' and estado order by id limit 1",
    );
    // The fixture users copy admin's password hash → they log in with DEV_PASSWORD.
    const upsertUsuario = async (
      userId: string,
      personaId: string,
      correo: string,
      nombre: string,
      rol = "Agricultor",
    ): Promise<string> => {
      await pgQuery(
        `insert into persona (id, nombre, apellido_paterno, fk_localidad)
         values ($1, $2, 'Fixture', $3)
         on conflict (id) do nothing`,
        [personaId, nombre, localidad.id],
      );
      await pgQuery(
        `insert into usuario (id, correo, password_hash, fk_persona, fk_rol)
         select $1, $2, u.password_hash, $3, r.id
         from usuario u, roles r
         where u.correo = $4 and r.nombre = $5
         on conflict (correo) do nothing`,
        [userId, correo, personaId, ADMIN, rol],
      );
      return (await pgUna<{ id: string }>("select id from usuario where correo = $1", [correo])).id;
    };
    const farmerId = await upsertUsuario(
      IDS.farmer,
      IDS.persona,
      "e2e-farmer@fixture.local",
      "Farmer",
    );
    const farmer2Id = await upsertUsuario(
      IDS.farmer2,
      IDS.persona2,
      "e2e-farmer2@fixture.local",
      "Farmerdos",
    );
    const vendedor2Id = await upsertUsuario(
      IDS.vendedor2,
      IDS.personaVendedor2,
      VENDEDOR2,
      "Vendedordos",
      "Vendedor",
    );

    const productoDe = async (nombre: string): Promise<{ id: string; fkUnidad: string | null }> =>
      pgUna<{ id: string; fkUnidad: string | null }>(
        'select id, fk_unidad as "fkUnidad" from producto where nombre = $1 and estado order by id limit 1',
        [nombre],
      );
    const unidad = await pgUna<{ id: string }>(
      "select id from unidad where abreviatura = 'kg' limit 1",
    );
    const categoria = await pgUna<{ id: string }>(
      "select id from categoria_producto where estado order by id limit 1",
    );

    const { isoWeekFromMonday } = await import("@rassa-jala/db/iso-semana");

    const upsertPub = async (id: string, dueno: string, fechaCiclo: string): Promise<void> => {
      const { semanaIso, anioIso } = isoWeekFromMonday(new Date(`${fechaCiclo}T00:00:00.000Z`));
      await pgQuery(
        `insert into publicacion_semanal (id, fk_agricultor, fecha_ciclo, semana_iso, anio_iso, estado, version)
         values ($1, $2, $3::date, $4, $5, 'publicado', 1)
         on conflict (id) do update set
           fk_agricultor = excluded.fk_agricultor,
           fecha_ciclo = excluded.fecha_ciclo, semana_iso = excluded.semana_iso,
           anio_iso = excluded.anio_iso, estado = 'publicado'`,
        [id, dueno, fechaCiclo, semanaIso, anioIso],
      );
    };
    const upsertItem = async (
      id: string,
      pubId: string,
      productoId: string,
      precio: string,
      stock: number,
    ): Promise<void> => {
      await pgQuery(
        `insert into producto_semanal (id, fk_publicacion, fk_producto, fk_unidad, precio, stock, estado, version)
         values ($1, $2, $3, $4, $5, $6, 'activo', 1)
         on conflict (id) do update set
           fk_publicacion = excluded.fk_publicacion, fk_producto = excluded.fk_producto,
           precio = excluded.precio, stock = excluded.stock, estado = 'activo'`,
        [id, pubId, productoId, unidad.id, precio, stock],
      );
    };

    const tomate = await productoDe("Tomate");
    const chile = await productoDe("Chile Serrano");
    const cilantro = await productoDe("Cilantro");
    const mango = await productoDe("Mango");
    // Two more 10.13 lines so ONE order proves 10.13×(1+2+3) = 60.78 (duplicate
    // producto_semanal ids are rejected by the adjudication).
    const frijol = await productoDe("Frijol");
    const papaya = await productoDe("Papaya");

    await upsertPub(IDS.pubActual, farmerId, lunes);
    await upsertPub(IDS.pubPast, farmerId, lunesPasado);
    await upsertPub(IDS.pubOtro, farmer2Id, lunes);
    // Deterministic stock/price every run (the suites assert on these exact rows).
    await upsertItem(IDS.itemActual, IDS.pubActual, tomate.id, "33.33", 5);
    await upsertItem(IDS.itemMoney, IDS.pubActual, chile.id, "10.13", 1000);
    await upsertItem(IDS.itemMoney2, IDS.pubActual, frijol.id, "10.13", 1000);
    await upsertItem(IDS.itemMoney3, IDS.pubActual, papaya.id, "10.13", 1000);
    await upsertItem(IDS.itemStock, IDS.pubActual, cilantro.id, "5.00", 10);
    await upsertItem(IDS.itemPast, IDS.pubPast, tomate.id, "21.50", 8);
    await upsertItem(IDS.itemOtro, IDS.pubOtro, mango.id, "7.77", 50);

    // QA maestro productos for the push lane (activo) and the inactive-maestro proof.
    for (const [id, nombre] of [
      [IDS.qaActivo, "QA Push Activo e2e"],
      [IDS.qaInactivo, "QA Push Inactivo e2e"],
    ] as const) {
      await pgQuery(
        `insert into producto (id, nombre, descripcion, fk_categoria, fk_unidad, estado)
         values ($1, $2, 'producto QA de las suites e2e', $3, $4, true)
         on conflict (id) do update set estado = true, fk_unidad = excluded.fk_unidad`,
        [id, nombre, categoria.id, unidad.id],
      );
    }
    await pgQuery("update producto set estado = false where id = $1", [IDS.qaInactivo]);

    // Outbox rows for the publications/items (once; fixed ids keep re-runs quiet).
    const asegurarOutbox = async (tabla: string, idFila: string): Promise<number> => {
      const previa = await pgQuery<{ mx: number }>(
        "select coalesce(max(id), 0)::int mx from sync_cambio where tabla_origen = $1 and id_fila = $2",
        [tabla, idFila],
      );
      if ((previa[0]?.mx ?? 0) > 0) return previa[0]?.mx ?? 0;
      await pgQuery(
        `insert into sync_cambio (tabla_origen, id_fila, operacion, actor)
         values ($1, $2, 'insert', 'e2e-fixture')`,
        [tabla, idFila],
      );
      const { mx } = await pgUna<{ mx: number }>(
        "select max(id)::int mx from sync_cambio where tabla_origen = $1 and id_fila = $2",
        [tabla, idFila],
      );
      return mx;
    };
    const seqPubActual = await asegurarOutbox("publicacion_semanal", IDS.pubActual);
    const seqItemActual = await asegurarOutbox("producto_semanal", IDS.itemActual);
    const seqPubPast = await asegurarOutbox("publicacion_semanal", IDS.pubPast);
    const seqItemPast = await asegurarOutbox("producto_semanal", IDS.itemPast);
    // The SECOND farmer's rows need outbox rows too, or the buyer/admin scoping
    // proofs can never see them (they never travel otherwise).
    await asegurarOutbox("publicacion_semanal", IDS.pubOtro);
    await asegurarOutbox("producto_semanal", IDS.itemOtro);

    return {
      farmerId,
      farmer2Id,
      vendedor2Id,
      pubActualId: IDS.pubActual,
      itemActualId: IDS.itemActual,
      itemMoneyId: IDS.itemMoney,
      itemMoney2Id: IDS.itemMoney2,
      itemMoney3Id: IDS.itemMoney3,
      itemStockId: IDS.itemStock,
      pubOtroId: IDS.pubOtro,
      itemOtroId: IDS.itemOtro,
      pubPastId: IDS.pubPast,
      itemPastId: IDS.itemPast,
      qaActivoId: IDS.qaActivo,
      qaInactivoId: IDS.qaInactivo,
      itemActualPrecio: "33.33",
      seqPubActual,
      seqItemActual,
      seqPubPast,
      seqItemPast,
    };
  })();
  return fixturePromise;
}

/** 'YYYY-MM-DD' → epoch ms (UTC-anchored, like iso-semana's parse). */
export function parseFechaCicloMs(fecha: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) throw new Error(`fecha inválida: ${fecha}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
