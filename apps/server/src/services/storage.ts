import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ENV } from "../env.server";

// D-1 storage adapter (architecture.md §11): one small interface, two drivers. The local
// disk driver backs development (files under STORAGE_LOCAL_DIR, served by GET /storage/*
// in apps/server/src/index.ts); the Supabase Storage driver (P0-C) serves the same keys
// from a PRIVATE bucket via short-lived signed URLs (the GET /storage/* route redirects
// to one, so the persisted url stays a stable server path in both drivers).

const DRIVER = {
  LOCAL: "local",
  SUPABASE: "supabase",
} as const;

export type GuardadoStorage = {
  storageKey: string;
  url: string;
};

export interface StorageDriver {
  /** Stores the bytes under a fresh key and returns it with its client-facing URL. */
  save(data: Uint8Array, ext: string, carpeta?: string): Promise<GuardadoStorage>;
  /** Best-effort delete: ENOENT is a no-op, other failures warn (orphan acceptable). */
  remove(storageKey: string): Promise<void>;
  /** Client-facing URL path for an already-stored key (e.g. "/storage/<key>"). */
  resolveUrl(storageKey: string): string;
  /** Absolute file path for local serving; undefined for remote drivers. */
  localPath?(storageKey: string): string;
  /**
   * Remote drivers only: a fresh short-lived read URL for an already-stored key.
   * Used by GET /storage/* to hand the client a time-limited direct link (private
   * bucket policy, P0-C). Absent on the local driver (route serves the file).
   */
  signedUrl?(storageKey: string): Promise<string>;
}

export class LocalDiskDriver implements StorageDriver {
  constructor(private readonly baseDir: string) {}

  async save(data: Uint8Array, ext: string, carpeta = "productos"): Promise<GuardadoStorage> {
    const storageKey = `${carpeta}/${crypto.randomUUID()}.${ext}`;
    const destino = this.localPath(storageKey);
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(destino, data);
    return { storageKey, url: this.resolveUrl(storageKey) };
  }

  async remove(storageKey: string): Promise<void> {
    await unlink(this.localPath(storageKey)).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ENOENT") {
        console.warn(`[storage] orphan file kept: ${storageKey}`, error);
      }
    });
  }

  resolveUrl(storageKey: string): string {
    return `/storage/${storageKey}`;
  }

  localPath(storageKey: string): string {
    return join(this.baseDir, storageKey);
  }
}

const STORAGE_TIMEOUT_MS = 15_000;
/** Signed-URL lifetime for reads: short by design (test env; each GET re-signs). */
const SIGNED_URL_TTL_S = 60;
const SUPABASE_BUCKET = "productos";

// T6 (gap-pass-9): chat media extensions (lib/media-firma) upload through the SAME
// driver — object content-type must match, or `<audio>/<video>` elements refuse to
// play the signed-URL response. Fallback keeps the previous image-only behavior sane.
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

interface ConfigSupabase {
  baseUrl: string;
  secretKey: string;
}

async function rest(
  config: ConfigSupabase,
  method: string,
  path: string,
  body?: string | Uint8Array,
  contentType?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    // Service-role key (backend only — architecture.md §7: the client never
    // talks to Supabase directly).
    Authorization: `Bearer ${config.secretKey}`,
  };
  if (contentType) headers["content-type"] = contentType;
  return fetch(`${config.baseUrl}/storage/v1${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
}

export class SupabaseStorageDriver implements StorageDriver {
  // D-1 (P0-C): PRIVATE bucket + short-lived signed URLs — simplest safe setup
  // for the test env: no public object access, no per-object ACL; reads are
  // time-boxed links minted on demand by the backend.
  private readonly config: ConfigSupabase;
  private readonly bucket = SUPABASE_BUCKET;
  private bucketReady: Promise<void> | null = null;

  constructor(config: ConfigSupabase) {
    this.config = config;
  }

  /** Keeps the bucket present (idempotent); runs once per process. */
  private asegurarBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const creado = await rest(
        this.config,
        "POST",
        "/bucket",
        JSON.stringify({ name: this.bucket, public: false }),
        "application/json",
      );
      // 409/400-with-already-exists = lost a creation race → fine, the bucket
      // exists either way. Note: the storage API reports "Bucket not found" as
      // HTTP 400 (body 404) — a plain GET /bucket/<name> is ambiguous.
      if (creado.ok || creado.status === 409) return;
      const cuerpo = await creado.text().catch(() => "");
      if (cuerpo.includes("already exists")) return;
      throw new Error(
        `Supabase Storage: bucket create failed (${creado.status}) ${cuerpo.slice(0, 120)}`,
      );
    })();
    return this.bucketReady;
  }

  async save(data: Uint8Array, ext: string, carpeta = "productos"): Promise<GuardadoStorage> {
    const storageKey = `${carpeta}/${crypto.randomUUID()}.${ext}`;
    await this.asegurarBucket();
    const res = await rest(
      this.config,
      "POST",
      `/object/${this.bucket}/${storageKey}`,
      data,
      CONTENT_TYPE_POR_EXTENSION[ext as keyof typeof CONTENT_TYPE_POR_EXTENSION] ??
        "application/octet-stream",
    );
    if (!res.ok) {
      throw new Error(`Supabase Storage: upload failed (${res.status})`);
    }
    return { storageKey, url: this.resolveUrl(storageKey) };
  }

  async remove(storageKey: string): Promise<void> {
    const res = await rest(this.config, "DELETE", `/object/${this.bucket}/${storageKey}`);
    // 404 = already gone → the ENOENT no-op the interface promises; other
    // failures keep the orphan (acceptable, same policy as the local driver).
    if (!res.ok && res.status !== 404) {
      console.warn(`[storage] orphan object kept: ${storageKey} (${res.status})`);
    }
  }

  resolveUrl(storageKey: string): string {
    // Same stable server path as the local driver: the persisted
    // producto_imagen.url never changes shape when STORAGE_DRIVER flips.
    return `/storage/${storageKey}`;
  }

  async signedUrl(storageKey: string): Promise<string> {
    const res = await rest(
      this.config,
      "POST",
      `/object/sign/${this.bucket}/${storageKey}`,
      JSON.stringify({ expiresIn: SIGNED_URL_TTL_S }),
      "application/json",
    );
    if (!res.ok) {
      throw new Error(`Supabase Storage: sign failed (${res.status})`);
    }
    const { signedURL } = (await res.json()) as { signedURL: string };
    return `${this.config.baseUrl}/storage/v1${signedURL}`;
  }
}

// Default root: <repoRoot>/storage (import.meta.dir = apps/server/src/services).
const REPO_ROOT = resolve(import.meta.dir, "../../../..");

export function createStorageDriver(): StorageDriver {
  if (ENV.STORAGE_DRIVER === DRIVER.SUPABASE) {
    const baseUrl = ENV.SUPABASE_URL?.trim() ?? "";
    const secretKey = ENV.SUPABASE_SECRET_KEY?.trim() ?? "";
    if (!baseUrl || !secretKey) {
      throw new Error("STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SECRET_KEY");
    }
    return new SupabaseStorageDriver({ baseUrl, secretKey });
  }
  return new LocalDiskDriver(ENV.STORAGE_LOCAL_DIR?.trim() || join(REPO_ROOT, "storage"));
}
