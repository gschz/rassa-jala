import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ENV } from "../env.server";

// D-1 storage adapter (architecture.md §11): one small interface, two drivers. The local
// disk driver backs development (files under STORAGE_LOCAL_DIR, served by GET /storage/*
// in apps/server/src/index.ts); the Supabase Storage driver connects at the FINAL project
// integration — until then it is an explicit stub, not a partial implementation.

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
  save(data: Uint8Array, ext: string): Promise<GuardadoStorage>;
  /** Best-effort delete: ENOENT is a no-op, other failures warn (orphan acceptable). */
  remove(storageKey: string): Promise<void>;
  /** Client-facing URL path for an already-stored key (e.g. "/storage/<key>"). */
  resolveUrl(storageKey: string): string;
  /** Absolute file path for local serving; undefined for remote drivers. */
  localPath?(storageKey: string): string;
}

export class LocalDiskDriver implements StorageDriver {
  constructor(private readonly baseDir: string) {}

  async save(data: Uint8Array, ext: string): Promise<GuardadoStorage> {
    const storageKey = `productos/${crypto.randomUUID()}.${ext}`;
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

export class SupabaseStorageDriver implements StorageDriver {
  // D-1: wired at the end of full project integration.
  async save(): Promise<GuardadoStorage> {
    throw new Error("Supabase Storage se conecta en la integración final (D-1)");
  }

  async remove(): Promise<void> {
    throw new Error("Supabase Storage se conecta en la integración final (D-1)");
  }

  resolveUrl(): string {
    throw new Error("Supabase Storage se conecta en la integración final (D-1)");
  }
}

// Default root: <repoRoot>/storage (import.meta.dir = apps/server/src/services).
const REPO_ROOT = resolve(import.meta.dir, "../../../..");

export function createStorageDriver(): StorageDriver {
  if (ENV.STORAGE_DRIVER === DRIVER.SUPABASE) return new SupabaseStorageDriver();
  return new LocalDiskDriver(ENV.STORAGE_LOCAL_DIR?.trim() || join(REPO_ROOT, "storage"));
}
