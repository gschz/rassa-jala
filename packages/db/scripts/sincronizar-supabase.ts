// Supabase TEST-env sync — ONE script (owner decision, 2026-11-23). Replaces the
// retired deploy-supabase.ts + import-selectivo.ts + verify-supabase.ts: after the
// migration collapse (single init 20261124041406) the whole clean state ships in
// the entrega/ backup, so syncing = restore it + mirror the storage files.
//
//   1. Reset schema public on Supabase (DROP CASCADE + CREATE) — over the
//      Supavisor session pooler (the direct host is IPv6-only on this machine).
//   2. Restore entrega/rassa_jala_v2_completo.sql via psql. The dump carries
//      `_prisma_migrations` with the collapsed init, so the restored DB is "in
//      sync" for Prisma — this run also doubles as the restore proof of the
//      entrega backup itself.
//   3. Mirror the local storage/ tree into the PRIVATE bucket `productos` with
//      `x-upsert: true` (re-runnable). The object key is the FULL storage_key
//      (e.g. "productos/<uuid>.webp" inside bucket "productos") — exactly what
//      SupabaseStorageDriver uploads to (POST /object/<bucket>/<storage_key>).
//   4. Verify: table counts local vs Supabase must be identical (same dump),
//      bucket listing must equal the local file set, and one real object must
//      roundtrip via a signed URL with identical bytes (sha256).
//
// Credentials never printed: packages/db/.env (SUPABASE_DATABASE_URL + the local
// DATABASE_URL used as the parity source) and apps/server/.env (SUPABASE_URL +
// SUPABASE_SECRET_KEY). Run: bun packages/db/scripts/sincronizar-supabase.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { Pool } from "pg";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const DUMP_PATH = join(REPO_ROOT, "entrega/rassa_jala_v2_completo.sql");
const STORAGE_DIR = join(REPO_ROOT, "storage");
const SERVER_ENV = join(REPO_ROOT, "apps/server/.env");

// Same bucket and content-type map as apps/server/src/services/storage.ts.
const BUCKET = "productos";
const CONTENT_TYPE_POR_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  webm: "video/webm",
  mov: "video/quicktime",
} as const;

const UPLOAD_CONCURRENCY = 8;

/** Loads SUPABASE_DATABASE_URL from packages/db/.env and derives the pooler URL.
 *  `pooler` keeps `uselibpqcompat=true` (Prisma/`pg` flavor); use `poolerLibpq`
 *  for psql/libpq, which rejects that parameter. */
export function loadSupabaseUrl(): {
  raw: string;
  pooler: string;
  poolerLibpq: string;
  ref: string;
} {
  const file = join(REPO_ROOT, "packages/db/.env");
  const env = readEnvValue(file, "SUPABASE_DATABASE_URL");
  const url = new URL(env);
  const ref = url.hostname.startsWith("db.")
    ? url.hostname.slice(3, -".supabase.co".length)
    : (url.hostname.split(".")[0] ?? "");
  if (!ref) throw new Error("Cannot derive the project ref from SUPABASE_DATABASE_URL");
  // Session pooler (IPv4-reachable); user gets the ref suffix the pooler routes on.
  url.hostname = "aws-1-us-east-2.pooler.supabase.com";
  url.username = `postgres.${ref}`;
  const sep = url.search ? "&" : "?";
  url.search += `${sep}sslmode=require&uselibpqcompat=true`;
  const libpq = new URL(url.toString());
  libpq.searchParams.delete("uselibpqcompat");
  return { raw: env, pooler: url.toString(), poolerLibpq: libpq.toString(), ref };
}

function readEnvValue(file: string, key: string): string {
  const content = readFileSync(file, "utf8");
  const value = content.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
  if (!value) throw new Error(`${key} not found in ${file}`);
  return value;
}

/** Hostname only — safe to print (no credentials). */
function host(url: string): string {
  return new URL(url).host;
}

interface ResultadoPaso {
  paso: string;
  ok: boolean;
  detalle: string;
}

const resultados: ResultadoPaso[] = [];
const reportar = (paso: string, ok: boolean, detalle = ""): void => {
  resultados.push({ paso, ok, detalle });
  console.log(`${ok ? "OK  " : "FAIL"}  ${paso}${detalle ? ` — ${detalle}` : ""}`);
};

// ---------------------------------------------------------------------------
// Step 1 — schema reset
// ---------------------------------------------------------------------------
async function resetSchema(pooler: string): Promise<void> {
  const pool = new Pool({ connectionString: pooler, max: 1 });
  try {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Step 2 — restore the entrega dump (psql child; libpq-flavored URL)
// ---------------------------------------------------------------------------
async function restaurarDump(poolerLibpq: string): Promise<void> {
  const proc = Bun.spawn(
    ["psql", poolerLibpq, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-q", "-f", DUMP_PATH],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const [salida, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`psql restore failed (exit ${code}):\n${(salida + err).trim().slice(-2000)}`);
  }
}

// ---------------------------------------------------------------------------
// Step 3 — mirror storage/ into the bucket (object key = full storage_key)
// ---------------------------------------------------------------------------
async function listarArchivosStorage(dir: string): Promise<string[]> {
  const entradas = await readdir(dir, { recursive: true });
  const archivos: string[] = [];
  for (const entrada of entradas) {
    if (entrada.startsWith(".")) continue;
    const info = await stat(join(dir, entrada));
    if (info.isFile()) archivos.push(entrada);
  }
  return archivos.sort();
}

async function subirArchivo(
  baseUrl: string,
  secretKey: string,
  rutaRelativa: string,
): Promise<void> {
  const bytes = await readFile(join(STORAGE_DIR, rutaRelativa));
  const ext = extname(rutaRelativa).slice(1).toLowerCase();
  const res = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${rutaRelativa}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "content-type":
        CONTENT_TYPE_POR_EXTENSION[ext as keyof typeof CONTENT_TYPE_POR_EXTENSION] ??
        "application/octet-stream",
      "x-upsert": "true",
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const cuerpo = await res.text().catch(() => "");
    throw new Error(`upload failed (${res.status}) ${rutaRelativa}: ${cuerpo.slice(0, 160)}`);
  }
}

async function subirArchivos(
  baseUrl: string,
  secretKey: string,
  archivos: string[],
): Promise<void> {
  for (let i = 0; i < archivos.length; i += UPLOAD_CONCURRENCY) {
    await Promise.all(
      archivos.slice(i, i + UPLOAD_CONCURRENCY).map((a) => subirArchivo(baseUrl, secretKey, a)),
    );
  }
}

// ---------------------------------------------------------------------------
// Step 4 — verification: count parity + storage parity + signed roundtrip
// ---------------------------------------------------------------------------
const TABLAS_PARIDAD = [
  "usuario",
  "persona",
  "producto",
  "producto_imagen",
  "municipio",
  "localidad",
  "estado_pedido",
  "pedido_cabecera",
  "mensaje",
  "documento",
  "sync_cambio",
  "familia",
  "conversacion",
] as const;

async function contarTablas(url: string, tablas: readonly string[]): Promise<Map<string, number>> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const counts = new Map<string, number>();
    for (const tabla of tablas) {
      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${tabla}"`);
      counts.set(tabla, r.rows[0]?.n ?? -1);
    }
    return counts;
  } finally {
    await pool.end();
  }
}

interface EntradaListado {
  name: string;
  /** null = folder placeholder (list API groups by "/") → recurse into it. */
  id: string | null;
}

/** Flat listing of every object in the bucket: the list API groups by folder
 *  (entries with id=null), so walk each placeholder prefix recursively. */
async function listarBucket(baseUrl: string, secretKey: string, prefix = ""): Promise<string[]> {
  const res = await fetch(`${baseUrl}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prefix, limit: 10_000, offset: 0 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`bucket list failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  }
  const entradas = (await res.json()) as EntradaListado[];
  const claves: string[] = [];
  for (const entrada of entradas) {
    if (entrada.id === null) {
      claves.push(...(await listarBucket(baseUrl, secretKey, `${prefix}${entrada.name}/`)));
    } else {
      claves.push(`${prefix}${entrada.name}`);
    }
  }
  return claves.sort();
}

async function roundtripFirmado(
  baseUrl: string,
  secretKey: string,
  clave: string,
): Promise<{ ok: boolean; detalle: string }> {
  const local = await readFile(join(STORAGE_DIR, clave));
  const shaLocal = createHash("sha256").update(new Uint8Array(local)).digest("hex");
  const sign = await fetch(`${baseUrl}/storage/v1/object/sign/${BUCKET}/${clave}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 60 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!sign.ok) return { ok: false, detalle: `sign failed (${sign.status}) ${clave}` };
  const { signedURL } = (await sign.json()) as { signedURL: string };
  const leido = await fetch(`${baseUrl}/storage/v1${signedURL}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!leido.ok) return { ok: false, detalle: `signed GET failed (${leido.status}) ${clave}` };
  const bytes = new Uint8Array(await leido.arrayBuffer());
  const shaLeido = createHash("sha256").update(bytes).digest("hex");
  return {
    ok: shaLeido === shaLocal && bytes.length === local.length,
    detalle: `${clave}: ${bytes.length} bytes, sha match=${shaLeido === shaLocal}`,
  };
}

async function main(): Promise<void> {
  const { pooler, poolerLibpq, ref } = loadSupabaseUrl();
  const baseUrl = readEnvValue(SERVER_ENV, "SUPABASE_URL");
  const secretKey = readEnvValue(SERVER_ENV, "SUPABASE_SECRET_KEY");
  const localUrl = readEnvValue(join(REPO_ROOT, "packages/db/.env"), "DATABASE_URL");

  console.log(`Target: Supabase TEST env (ref ${ref}) via ${host(pooler)}`);
  console.log(`Mirror source: local dev DB (${host(localUrl)}) + ${STORAGE_DIR}\n`);

  // 0. Fresh dump — the mirror target is the CURRENT dev state, not a stale
  //    snapshot: this also refreshes the entrega/ delivery backups on every run.
  const devDump = Bun.spawnSync(
    ["pg_dump", localUrl, "--no-owner", "--no-privileges", "-f", DUMP_PATH],
    { cwd: REPO_ROOT },
  );
  Bun.spawnSync(
    [
      "pg_dump",
      localUrl,
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "-f",
      join(REPO_ROOT, "entrega/rassa_jala_v2_esquema.sql"),
    ],
    { cwd: REPO_ROOT },
  );
  if (devDump.exitCode !== 0) {
    console.error(`pg_dump failed (exit ${devDump.exitCode}) — aborting before touching Supabase`);
    process.exit(1);
  }
  console.log("OK    0.dump-fresh — entrega/ dumps regenerated from the local dev DB\n");

  // 1. Reset
  try {
    await resetSchema(pooler);
    reportar("1.reset-schema", true, "public dropped + recreated");
  } catch (error) {
    reportar("1.reset-schema", false, error instanceof Error ? error.message : String(error));
    throw error;
  }

  // 2. Restore
  try {
    await restaurarDump(poolerLibpq);
    reportar(
      "2.restore-dump",
      true,
      "entrega/rassa_jala_v2_completo.sql restored (also proves the entrega backup restores cleanly)",
    );
  } catch (error) {
    reportar("2.restore-dump", false, error instanceof Error ? error.message : String(error));
    throw error;
  }

  // 3. Storage mirror
  const archivos = await listarArchivosStorage(STORAGE_DIR);
  try {
    await subirArchivos(baseUrl, secretKey, archivos);
    reportar(
      "3.storage-upload",
      true,
      `${archivos.length} files upserted to bucket "${BUCKET}" (key = full storage_key)`,
    );
  } catch (error) {
    reportar("3.storage-upload", false, error instanceof Error ? error.message : String(error));
    throw error;
  }

  // 4. Verify
  const tablas = [...TABLAS_PARIDAD, "_prisma_migrations"];
  const [local, supabase] = await Promise.all([
    contarTablas(localUrl, tablas),
    contarTablas(pooler, tablas),
  ]);
  const divergencias = tablas.filter((t) => local.get(t) !== supabase.get(t));
  console.log("\ncounts (local vs supabase):");
  for (const tabla of tablas) {
    console.log(`  ${tabla.padEnd(20)} ${local.get(tabla) ?? -1} / ${supabase.get(tabla) ?? -1}`);
  }
  reportar(
    "4a.count-parity",
    divergencias.length === 0,
    divergencias.length === 0
      ? `${tablas.length} tables identical`
      : `divergent: ${divergencias.join(",")}`,
  );

  const enSupabase = await listarBucket(baseUrl, secretKey);
  const faltan = archivos.filter((a) => !enSupabase.includes(a));
  const sobran = enSupabase.filter((a) => !archivos.includes(a));
  reportar(
    "4b.storage-parity",
    faltan.length === 0 && sobran.length === 0,
    `${enSupabase.length} objects in bucket vs ${archivos.length} local files; missing=${faltan.length} extra=${sobran.length}${faltan.length ? ` missing: ${faltan.slice(0, 5).join(",")}` : ""}${sobran.length ? ` extra: ${sobran.slice(0, 5).join(",")}` : ""}`,
  );

  const claveRoundtrip = archivos.find((a) => a.startsWith("productos/")) ?? archivos[0];
  if (!claveRoundtrip) throw new Error("no local files under storage/ to roundtrip");
  const roundtrip = await roundtripFirmado(baseUrl, secretKey, claveRoundtrip);
  reportar("4c.storage-roundtrip", roundtrip.ok, roundtrip.detalle);
  if (!roundtrip.ok) throw new Error(`storage roundtrip failed: ${roundtrip.detalle}`);

  console.log("\n=== sincronizar-supabase summary ===");
  for (const r of resultados) console.log(`${r.paso.padEnd(20)} ${r.ok ? "OK" : "FAIL"}`);
  if (resultados.some((r) => !r.ok)) process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("sincronizar-supabase failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
