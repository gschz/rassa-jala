# Feature: foundation-consolidation

## Objective
Consolidate the four base documents (docs/architecture.md, docs/database.md, docs/synchronization.md, docs/scope.md) using the existing audit (docs/01-audit/), then prepare minimal infrastructure and deliver a working vertical slice: React(Bun) + tRPC(Bun) + Prisma → Supabase Postgres + RxDB(IndexedDB) with offline read/write, PULL/PUSH replication, reconnect recovery, and Postgres persistence proof.

## Problem / Why
The audit produced the factual baseline; the four architecture docs are templates that must be consolidated against the audit and the delivered PostgreSQL database before implementation. The user requires a working end-to-end offline-first flow before building business modules.

## Authorized scope (mutation)
- EDIT ONLY: docs/architecture.md, docs/database.md, docs/synchronization.md, docs/scope.md (consolidation, in Spanish, extending existing docs).
- CREATE: odd/tasks/foundation-consolidation.md (this tracker); code under apps/server, apps/web, packages/db, packages/api (and their configs) for the vertical slice.
- `legacy/**`: strictly READ-ONLY. No new report files (docs/01-audit untouched). No redundant docs.
- Delivered PostgreSQL (credentials in apps/server/.env): read-only introspection allowed; slice may CREATE NEW tables and INSERT new rows only; NO alteration/drop of existing tables or data changes — any such need = STOP and ask the user.

## Constraints (from user task)
- Mandatory stack: React+TS, Bun, tRPC, Prisma, Supabase PG, RxDB, IndexedDB, Vite+Workbox, TanStack Query, Tailwind, shadcn/ui, Bun Workspaces. PowerSync discarded. No Express, no microservices, no extra infra.
- TZ: America/Mazatlan for presentation; instants stored UTC.
- Do not confuse mocked/incomplete legacy features with working ones. No simulated functionality.
- Financial and relational integrity protected; server-side enforcement for critical operations.
- Autonomy: proceed on minor technical decisions; STOP only for contradictory business rules, data-affecting changes, financial integrity, security risks, or fundamental architecture changes.

## Route declaration (ODD triggers)
- T1 recon: inline (4 docs + scaffold read for routing; 6 files).
- T2 database.md consolidation: DELEGATED writer (introspection + audit contrast; 4+ sources).
- T3 architecture.md + scope.md consolidation: DELEGATED writer (audit cross-reference, 4+ sources).
- T4 synchronization.md consolidation: DELEGATED writer (depends T2 collections; RxDB protocol design).
- T5 consolidation gate: inline cross-check of the 4 docs.
- T6 slice server: DELEGATED writer (Express removal, Prisma curated subset, sync endpoints, seed).
- T7 slice web: DELEGATED writer (RxDB + replication client + offline UI) depends T6 contract.
- T8 slice verification: inline bounded (typecheck, build, db push/generate, smoke run) + fresh workers if needed.
- T9 close: inline (mirror, session summary, report).

## TDD
Off by default for consolidation docs. For slice code: resolve from project config — Better-T-Stack scaffold has no test runner configured yet; keep TDD off for the slice but require the sync protocol's observable checks (replication round-trip, reconnect, persistence verification) as functional verification. Record any test infra decision in the tracker if made.

## Delivery
Forecast: ~600 lines doc edits + ~1500-2500 lines slice code. Strategy: ask-on-risk (default) — but agents create no commits/PRs (runtime denies git commit; commits are user-owned). No PR chaining machinery will be invoked; the user commits work units under ordinary policy.

## Checklist
- [x] T1 recon: docs exist (architecture 154, database 125, synchronization 173, scope 145); scaffold Better-T-Stack (Express present, @hono/trpc-server present, Prisma 7 + adapter-pg, TanStack Router/Query, vite-plugin-pwa, varlock); DATABASE_URL and VITE_SERVER_URL non-empty; packages/ui absent; placeholder Todo schema. — 2026-11-16
- [x] T2 docs/database.md consolidated (introspection + audit contrast)
- [x] T3 docs/architecture.md + docs/scope.md consolidated (module classification P0-P2)
- [x] T4 docs/synchronization.md consolidated (RxDB protocol concrete)
- [x] T5 consolidation gate (cross-doc coherence)
- [x] T6 slice server implemented
- [x] T7 slice web implemented
- [x] T8 slice verified end-to-end (9 proof points from task §7)
- [x] T9 close

## Acceptance criteria
- Four docs consolidated coherently with audit; contradictions and pending decisions explicit; no new report files.
- Vertical slice proves the 9 points of task §7 with real data and real Postgres persistence.
- No legacy modification; no simulated functionality presented as real; financial integrity server-side.

## Progress
- T1 done 2026-11-16: recon complete (see checklist note).
- T3 done 2026-11-16: architecture.md + scope.md consolidated in place (Spanish). Server = Bun.serve + @hono/trpc-server (Express to be removed); RxDB = getRxStorageDexie (rxdb/plugins/storage-dexie, Apache-2.0, verified via context7); TanStack Router/Query; Prisma 7 adapter-pg; varlock; vite-plugin-pwa. packages/ui exists (@rassa-jala/ui) — reconciled. scope.md §3.1: 20 modules classified (CONSERVAR 6, CORREGIR 4, COMPLETAR 3, NUEVA 4, SIMPLIFICAR 1, VALIDAR 2; P0 11, P1 7, P2 2) with audit refs; P0 blockers Q-19/Q-29/Q-14/Q-06/Q-10/Q-05/Q-07/Q-25/Q-21/Q-27; pending D-1 image storage (Supabase Storage proposed default); 9 slice proof points in scope §7.1. Engram obs 931.
- T2 done 2026-11-16: database.md consolidated (494 lines). DATABASE_URL -> EMPTY `postgres` DB (PG 18.6, localhost:5432) = new project destination; legacy populated DB is `rassa_jala_db` (46 tables = 34 business + 12 framework) introspected read-only. Contrasts: migration 0027 not applied (merma.fk_pedido missing); FKs have NO SQL-level on_delete (DEFERRABLE NO ACTION — Prisma referential actions must be explicit); delivered legacy seed data violates financial invariants (pago.monto != pedido.total 4/4, duplicate liquidacion fk_pago, folios LEGACY-N, producto.precio=0); IVA contradiction: data 16% vs audit/legacy-code 21% -> D-3 pending (Mexico context suggests 16%; NOT blocking slice); no table has actualizado_en (M-1b needed for incremental PULL); 7 auto CHECKs >=0 exist. Modifications M-1..M-7 proposed (M-1a outbox sync_cambio, M-2 financial CHECKs and M-3 UUID PK = PENDING USER DECISION). Pending decisions D-2..D-9. Engram obs 932.
- T4 done 2026-11-16: synchronization.md consolidated (267 lines): checkpoint = last delivered sync_cambio.id with gap-window rule (contiguous seq prefixes); PUSH per-doc verdicts (aplicada/conflicto/rechazada) with per-row version (SP-2); sync_operacion idempotency table in same tx (fixes F-13/F-14); S1 catalogs PULL-only; reconnect via native retry + reSync; RxDB API shapes verified via context7. Slice: PULL municipios/localidades/categorias/unidades (+estados_pedido/tipos_pago), PUSH demo = localidades (mechanism-demo exception, S1 classification unchanged). Engram obs 933.
- T5 done 2026-11-16: parent gate PASS — 4 docs (1163 lines) cross-referenced coherently; D-1..D-9 registers consistent; slice collections identical in sync §14 and database §6.2; 9 proof points in scope §7.1; rxdb + fake-indexeddb pre-installed in apps/web (single lockfile writer strategy for slice).
- T6 done 2026-11-16: server slice — Prisma models municipio/localidad/categoria_producto/unidad (UUID PK gen_random_uuid + legacy_id unique + estado + version + actualizado_en), outbox sync_cambio (bigserial cursor) + sync_operacion (idempotencia, same-tx), per-collection tRPC procedures (sync.<coleccion>.pull, sync.localidades.push), Bun.serve + @hono/trpc-server (Express removed), seed Nayarit idempotente; pull/push + replay verificados con prueba de triple escritura transaccional (localidad + sync_cambio + sync_operacion). Engram obs 934.
- T7 done 2026-11-16: web slice — RxDB 17.6 + getRxStorageDexie (fake-indexeddb en pruebas), 4 colecciones S1, replicateRxCollection con server-wins, sync-status store (useSyncExternalStore, sin deps nuevas), UI slice en español (listado reactivo + crear localidad con pendiente/confirmado), build PWA emite sw.js + manifest; rxdb-check 3/3 PASS. Engram obs 935.
- T8 done 2026-11-16: e2e headless 9/9 PASS (kill/respawn del servidor, escritura offline recuperada por retry, conflicto por versionAsumida con server-wins, tombstone propagado, replay idempotente con conteos PG idénticos 21→21). Reconciliaciones: rutas por colección + clave limite + fix DB9 (dev-mode plugin). Residuales: syncOpId solo en inserts (convergencia por estado final), delete→1 conflicto transitorio, test manual de navegador pendiente del usuario. Engram obs 936.
- T9 done 2026-11-16: espejo final + resumen de sesión + informe entregado. Commits propiedad del usuario (runtime lo deniega a los agentes).
