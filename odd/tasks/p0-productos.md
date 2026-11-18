# Feature: p0-productos

## Objective

P0 Productos (docs/scope.md §3.1 — COMPLETAR): producto maestro CRUD (Admin-only per Q-19) with categorias/unidades association, image upload via a pluggable storage adapter (local-disk driver in dev; Supabase Storage driver at final integration per D-1), S1 PULL collections for productos/producto_imagenes. The weekly cycle (publicacion_semanal/producto_semanal, Q-25) is a SEPARATE follow-up feature — out of scope here.

## Problem / Why

Products feed publicaciones/pedidos. Legacy farmer product screens called Admin-only endpoints (F-17/Q-19 resolved: maestro = Admin CRUD); legacy admin CRUD was mocked in the web UI. Images previously went through two divergent Google Drive pipelines (F-10) — replaced by the storage adapter per D-1.

## Decisions applied

- Q-19: producto maestro CRUD = Admin only; Agricultor manages weekly offers later (publicaciones feature); Vendedor neither.
- D-1 (RESUELTA 2026-11-17): Supabase Storage in production; LOCAL-DISK driver in dev while using the local DB; Supabase connection happens at the end of full project integration. Storage adapter with two drivers selected by env.

## Authorized scope (mutation)

- packages/db: producto + producto_imagen models (per database.md §3.2 rows: principal/orden flags, estado, version, actualizado_en, legacy_id?), migration, seed (sample productos).
- apps/server: storage adapter service (local driver + supabase stub), GET /storage/:key serving (dev), env keys STORAGE_DRIVER/STORAGE_LOCAL_DIR (+ .env.schema).
- packages/api: productos router (CRUD Admin-only, outbox) + imagenes (upload/link/delete, Admin-only) + sync pull for productos/producto_imagenes.
- apps/web: /productos admin page (CRUD + image upload/preview/principal + delete), header nav.
- docs: NO edits expected (D-1 already recorded in architecture.md by parent). If a model nuance arises, one-line M-register addition allowed.
- legacy/** READ-ONLY. Do NOT model publicacion_semanal/producto_semanal here.

## Route declaration

- T1 D-1 recorded + tracker: inline (done).
- T2 productos module: DELEGATED single writer.
- T3 gate + close: inline.

## TDD

Off (no runner). Functional checks: curl proofs (CRUD + upload→disk file + serve GET + principal + delete unlink + role 403 + PULL propagation), suites green, lint/build.

## Delivery

Forecast: ~1000-1400 authored lines. Strategy: ask-on-risk (default); agents create no commits (user-owned).

## Checklist

- [x] T1 D-1 recorded (architecture.md §11) + tracker — 2026-11-17
- [x] T2 productos module (delegated)
- [x] T3 gate + close

## Acceptance criteria

- Admin CRUD producto maestro real (create/update/soft-delete with outbox + CAS version).
- Image upload stores via adapter (disk in dev), row + outbox, served over HTTP, principal/orden flags, delete removes row (+ best-effort unlink).
- Agricultor/Vendedor mutations → 403.
- PULL propagation: productos/producto_imagenes arrive from old checkpoints; no secrets/binaries in PULL docs (url/storageKey refs only).
- check/lint/check-types clean; suites green (slice-e2e 9 points, rxdb-check 5, familias/usuarios e2e); build OK.

## Progress

- T2 done 2026-11-18: productos module complete — producto + producto_imagen (migración 20261118003023 con partial unique 'un principal por producto' + CHECK orden>=0; seed 6 productos idempotente); adaptador StorageDriver (LocalDiskDriver funcional bajo storage/ gitignored; SupabaseStorageDriver STUB D-1; selección por STORAGE_DRIVER); servicio GET /storage/* con guard anti-traversal y content-type correcto; productos.{list,create,update,setEstado} + productos.imagenes.{upload,setPrincipal,delete} (Admin-only, transacción única fila+outbox, CAS→409, upload valida mime/ext/≤5MiB fuera de tx con rollback de archivo, primera imagen principal auto, orden=max+1, delete físico + outbox + unlink best-effort); sync.productos.pull + sync.imagenes.pull (PULL global, refs url/storageKey sin binarios); web /productos admin (CRUD + pickers + papelera + panel de imágenes con preview/principal/borrar), nav Admin-only. Verificación: productos-e2e 28 PROOFS ALL PASS (incl. archivo en disco 69 bytes, GET 200 image/png, unlink, 403s, PULL desde checkpoint viejo con tombstone); rxdb-check 5 PASS; slice-e2e ALL PHASES EXIT=0; usuarios-e2e + familias-e2e + role-freshness ALL PASS; check/lint/types 6/6; build OK. Engram obs 956. §6.2 ajustado (scoping Q-19; eliminar_pendiente eliminado por D-1).
- T3 done 2026-11-18 (parent gate): check-types 6/6 re-ejecutado; storage/ en .gitignore (línea 15) y legacy/ ya ignorado (resuelve el problema del assess); selección de driver correcta. Commits propiedad del usuario.
- Residuales: upload base64 MVP (shortcut: magic-bytes + multipart como upgrade; tope 5MiB); sin auto-promoción de principal al borrar la principal; 5 filas 'Producto QA' desactivadas quedan en papelera dev; STORAGE_LOCAL_DIR opcional.
- Siguiente: p0-publicaciones (Q-25) — ciclo semanal S2 con borradores offline del Agricultor + catálogo para Cliente.
