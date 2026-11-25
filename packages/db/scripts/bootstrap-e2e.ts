/**
 * Isolated e2e database bootstrap (owner decision T11c, 2026-11-24).
 *
 * Recreates `rassa_jala_db_e2e` FROM SCRATCH on every run:
 *   drop → create → `prisma migrate deploy` → seed ×1
 * then writes `packages/db/.env.e2e` with the `E2E_DATABASE_URL=<url>` line
 * that apps/web/e2e/helpers.ts falls back to (process env still wins). The dev
 * DB (`rassa_jala_db_v2`) keeps seed + real data — the battery never touches it
 * (replaces the retired cleanup-dev.ts).
 *
 * Hard guard: the derived URLs MUST point at a LOCAL PostgreSQL (localhost/
 * 127.0.0.1/::1) and the target name MUST be exactly `rassa_jala_db_e2e` —
 * never an external host (Supabase), the legacy `rassa_jala_db` or the dev v2.
 * Idempotent: running it ×2 works the same (drop/create every time).
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const E2E_DB = "rassa_jala_db_e2e";
const LEGACY_DB = "rassa_jala_db";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const E2E_ENV_PATH = fileURLToPath(new URL("../.env.e2e", import.meta.url));
const DB_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Runs a command in `cwd` with `env` and streams output; rejects on non-zero. */
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
    });
  });
}

/** [e2eUrl, adminUrl] — same connection params, different database path. */
function deriveUrls(rawUrl: string): { e2eUrl: string; adminUrl: string } {
  const abort = (why: string): never => {
    console.error(`[bootstrap-e2e] GUARD: ${why} — ABORTED.`);
    process.exit(1);
  };
  const url = new URL(rawUrl);
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    abort(
      `source host '${url.hostname}' is not local (localhost/127.0.0.1/::1) — never an external host (Supabase)`,
    );
  }
  const sourceDb = url.pathname.slice(1);
  if (sourceDb === LEGACY_DB) {
    abort(`source is the legacy '${LEGACY_DB}' (READ-ONLY, sacred)`);
  }
  if (sourceDb === E2E_DB) {
    abort(`source is already '${E2E_DB}' — point DATABASE_URL at the dev DB`);
  }
  const e2e = new URL(rawUrl);
  e2e.pathname = `/${E2E_DB}`;
  const admin = new URL(rawUrl);
  admin.pathname = "/postgres";
  // Belt-and-suspenders: the ONLY allowed target name, byte-exact.
  if (e2e.pathname !== `/${E2E_DB}`) abort(`derived target is not exactly '${E2E_DB}'`);
  return { e2eUrl: e2e.toString(), adminUrl: admin.toString() };
}

async function main(): Promise<void> {
  const rawUrl = /^DATABASE_URL=(.*)$/m.exec(await readFile(ENV_PATH, "utf8"))?.[1]?.trim();
  if (!rawUrl) {
    console.error("[bootstrap-e2e] DATABASE_URL not found in packages/db/.env — ABORTED.");
    process.exit(1);
  }
  const { e2eUrl, adminUrl } = deriveUrls(rawUrl);

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    try {
      // PG13+: FORCE drops even with attached servers (e.g. a stale :3010 fixture).
      await client.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
    } catch (error) {
      // Older PG without WITH (FORCE): terminate sessions, then plain drop.
      console.error(
        "[bootstrap-e2e] FORCE drop unavailable, falling back:",
        error instanceof Error ? error.message : String(error),
      );
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = '${E2E_DB}' AND pid <> pg_backend_pid()`,
      );
      await client.query(`DROP DATABASE IF EXISTS ${E2E_DB}`);
    }
    await client.query(`CREATE DATABASE ${E2E_DB}`);
  } finally {
    await client.end();
  }

  // Process env wins over the .env (varlock/dotenv precedence) — same verified
  // pattern as the e2e server fixture.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: e2eUrl };
  await run("bunx", ["--bun", "prisma", "migrate", "deploy"], DB_DIR, childEnv);
  await run("bun", ["prisma/seed.ts"], DB_DIR, childEnv);

  await writeFile(E2E_ENV_PATH, `E2E_DATABASE_URL=${e2eUrl}\n`, "utf8");
  console.log(
    `[bootstrap-e2e] ${E2E_DB} recreated (drop/create/migrate/seed ×1) — url written to packages/db/.env.e2e`,
  );
}

main().catch((error) => {
  console.error("[bootstrap-e2e] FAILED:", error);
  process.exit(1);
});
