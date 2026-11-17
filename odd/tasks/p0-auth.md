# Feature: p0-auth

## Objective

Implement the P0 Autenticación module (docs/scope.md §3.1 — CORREGIR, fixes F-01: login must reject Usuario.estado=false) plus the usuarios/roles base needed by it, on the local database `rassa_jala_db_v2`, with standing lint/format discipline.

## Problem / Why

Auth is the first P0 module and unblocks user-scoped sync (synchronization.md §11), replacing the slice's dev-stub actor. The audit found login did not check Usuario.estado (F-01) — the new implementation must fix it.

## Environment decision (user, 2026-11-17)

- Local DB without Supabase: `rassa_jala_db_v2` (host localhost, user postgres). `packages/db/.env` AND `apps/server/.env` DATABASE_URL now point to it.
- Baseline migration `init` created (7 tables) + Nayarit seed applied. `rassa_jala_db_v2` existed empty; nothing was destroyed.
- Standing rule (user): fix lint errors as development proceeds; auto-format with package.json commands (`bun run check`, `bun run lint`).

## Authorized scope (mutation)

- EDIT/CREATE: packages/db (auth-domain Prisma models + migration + seed), packages/api (auth router + protectedProcedure), apps/server (JWT context, CORS credentials, JWT secrets in env), apps/web (login page, session handling, protected slice route, sync-client auth header).
- Deps allowed: `jose` (JWT) — single lockfile writer this round.
- legacy/** READ-ONLY. No docs edits (module completion is recorded here, not in docs).

## Route declaration

- T1 env/db switch + baseline migration + seed + lint baseline: inline (mechanical).
- T2-T5 auth implementation (schema→server→web): DELEGATED single writer (coherent cross-package module; 2+ non-trivial files; contract spans packages).
- T6 verification gate: inline readback of worker evidence + spot check.
- T7 close: inline mirror + summary + report.

## TDD

Off (no runner configured). Functional checks: curl-level auth flow proofs (login/me/refresh/logout/F-01 rejection) + slice e2e still PASS + typechecks + lint. Test infra decision deferred.

## Delivery

Forecast: ~1200-1800 authored lines. Strategy: ask-on-risk (default). Agents create no commits/PRs (user-owned). Work units: env+baseline; auth module.

## Checklist

- [x] T1 env/db switch to rassa_jala_db_v2 + baseline migration init + seed + lint baseline (check/lint/check-types clean) — 2026-11-17
- [x] T2 auth-domain models + migration + seed (rol, persona, usuario, refresh_token; admin + estado=false test user)
- [x] T3 server auth (JWT access/refresh httpOnly cookie, login/refresh/logout/me/changePassword, protectedProcedure, sync actor = real user)
- [x] T4 web auth (login route, session context, auto-refresh on 401, protected slice route, sync-client Authorization header, Spanish UI)
- [x] T5 verification: typechecks 6/6 + check/lint clean + curl flow proofs incl. F-01 + slice-e2e PASS (with auth)
- [x] T6 gate readback
- [x] T7 close

## Acceptance criteria

- login rejects usuario.estado=false (F-01 fixed) with clear message; wrong password 401; refresh rotates and revokes; logout revokes; me returns user+rol.
- Slice still works end-to-end with authenticated replication (actor = real user id).
- `bun run check`, `bun run lint`, `bun run check-types` all clean.
- No legacy modification; no docs edits; secrets only in env files (never printed).

## Progress

- T1 done 2026-11-17: sed DATABASE_URL -> /rassa_jala_db_v2 in apps/server/.env + packages/db/.env (masked verification); DB existed empty; `prisma migrate dev --name init` baseline (7 tables); seed 5/10/4/3; lint baseline clean after removing one unused import (apps/web/src/routes/index.tsx).
- T2-T5 done 2026-11-17: worker #1 wrote the module but died on a runtime transport error (ETXTBSY spawning git) before verification; worker #2 reconciled it (coherent), completed gaps: seed 3 users (admin, agricultor@rassa.local non-admin, bloqueado@rassa.local estado=false; idempotente) + fixed broken phase-G assertion in slice-e2e (outbox actor whitelist 'dev-seed'; sync_operacion strict). Migration add_auth_base applied. Auth: access JWT 15min, refresh opaque hashed httpOnly cookie (path /trpc, 7d) with rotation + full-family revocation on reuse, logout, me, changePassword (Bun.password argon2id); protectedProcedure; sync.* auth-required, actor = real user id, push localidades Admin-only (Agricultor -> 403). Web: /login en español, authFetch single-flight 401 refresh, slice protegida, header con identidad + logout.
- T6 done 2026-11-17 (parent gate): F-01 verificado en código (routers/auth.ts:81 y :112, rechazo ANTES de emitir tokens, en login y refresh) + prueba curl (403 'Usuario desactivado'); seed grep-confirmado; push role check en sync.ts:516; check/lint/check-types limpios (226 archivos); puerto 3000 libre. Evidencia del worker: rotación de refresh + revocación familiar, sync 401 sin auth, push admin aplicada con actor=real id (SELECT verificado), slice-e2e 12 PASS con login (EXIT=0), build web OK (sw.js). Engram obs 941.
- T7 done 2026-11-17: espejo actualizado (obs 940), resumen de sesión guardado (obs 942), informe entregado. Commits propiedad del usuario.
- Residuales (aceptados, solo-dev): slice-e2e puede dejar servidor huérfano si una fase falla (matar antes de re-ejecutar); credenciales dev inline en slice-e2e; syncOpId solo en inserts (convergencia por estado final); docs/01-audit/*.md conservan un reformateo cosmético de oxfmt vs el commit del usuario (contenido idéntico) — restaurable con `git checkout -- docs/01-audit/` si se desea.
