// Read-only connection guard for the P0-D legacy import (T2a).
//
// Hard rule (odd/tasks/p0-import.md + docs/database.md §2.1): `rassa_jala_db`
// (legacy) is READ-ONLY FOREVER. Defense in depth:
//   1. The module refuses to connect to any database other than the expected
//      target (`SELECT current_database()` proof at open, abort otherwise).
//   2. The libpq session is pinned to `default_transaction_read_only=on` and
//      `TimeZone=UTC` (gap 16 — the conSesionUtc substance applied to raw pg
//      connections, which the import scripts use outside Prisma).
//   3. The whole run happens inside one explicit `BEGIN TRANSACTION READ ONLY`
//      (server-enforced: even a slipped write verb is rejected by PostgreSQL).
//   4. Every statement passes a client-side verb allowlist
//      (SELECT/WITH/SHOW/EXPLAIN + the tx control statements).
// The guard is proven live by proveGuard(): an UPDATE inside the read-only
// transaction MUST be rejected by the server; the transaction is rolled back
// right after, so no data can change in any path.

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { readFile } from "node:fs/promises";

export const LEGACY_DB = "rassa_jala_db";
export const V2_DB = "rassa_jala_db_v2";

const ALLOWED_FIRST_WORD = new Set(["SELECT", "WITH", "SHOW", "EXPLAIN"]);

/** Derives a pinned read-only URL for `db` from the v2 DATABASE_URL (same instance). */
function readOnlyUrl(sourceUrl: string, db: string): string {
  const url = new URL(sourceUrl);
  url.pathname = `/${db}`;
  const previous = url.searchParams.get("options") ?? "";
  url.searchParams.set(
    "options",
    `${previous} -c TimeZone=UTC -c default_transaction_read_only=on`.trim(),
  );
  return url.toString();
}

/** Client-side verb check: only read statements (plus tx control) may be sent. */
export function assertReadOnly(sql: string): void {
  const stripped = sql.replace(/--[^\n]*/g, "").trim();
  const first = (stripped.split(/\s+/)[0] ?? "").toUpperCase();
  if (first === "BEGIN" && /READ\s+ONLY/i.test(sql)) return;
  if (first === "COMMIT" || first === "ROLLBACK") return;
  if (!ALLOWED_FIRST_WORD.has(first)) {
    throw new Error(`Guard: statement refused (not a read): ${first || "(empty)"}`);
  }
}

/** DATABASE_URL: packages/db/.env is the pinned v2 source (same instance hosts legacy). */
export async function loadDbUrl(): Promise<string> {
  const raw = await readFile(new URL("../.env", import.meta.url), "utf8");
  const match = raw.match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error("DATABASE_URL not found in packages/db/.env");
  return match[1]!.trim();
}

export class ReadOnlyReader {
  private pool: Pool;
  private client: PoolClient | null = null;

  constructor(
    readonly expectedDb: string,
    sourceUrl: string,
  ) {
    this.pool = new Pool({ connectionString: readOnlyUrl(sourceUrl, expectedDb), max: 1 });
  }

  private conn(): PoolClient {
    if (!this.client) throw new Error("ReadOnlyReader: call open() first");
    return this.client;
  }

  /** Proves the target identity and opens the server-enforced READ ONLY transaction. */
  async open(): Promise<string> {
    const client = await this.pool.connect();
    this.client = client;
    const proof = await client.query<{ db: string }>("SELECT current_database() AS db");
    const observed = proof.rows[0]?.db ?? "";
    if (observed !== this.expectedDb) {
      client.release();
      this.client = null;
      await this.pool.end();
      throw new Error(
        `Guard: expected database "${this.expectedDb}", connected to "${observed}" — aborting`,
      );
    }
    await client.query("BEGIN TRANSACTION READ ONLY");
    return observed;
  }

  async query<T extends QueryResultRow>(sql: string): Promise<T[]> {
    assertReadOnly(sql);
    const result = await this.conn().query<T>(sql);
    return result.rows;
  }

  /** Dry demonstration: a write inside a READ ONLY tx must be refused server-side.
   * Runs on its own one-off connection (the refusal aborts the demo transaction,
   * and the main READ ONLY tx of the run must not be reused after it). */
  async proveGuard(table: string): Promise<string> {
    const probe = new Pool({ connectionString: this.pool.options.connectionString, max: 1 });
    const client = await probe.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      try {
        await client.query(`UPDATE ${table} SET nombre = nombre`);
        return "FATAL — the write was NOT refused; the guard is broken";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `OK — server refused the write: ${message}`;
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
      await probe.end();
    }
  }

  /** COMMIT of a read-only transaction changes nothing; safe close on any path. */
  async close(): Promise<void> {
    const client = this.conn();
    await client.query("ROLLBACK");
    client.release();
    this.client = null;
    await this.pool.end();
  }
}
