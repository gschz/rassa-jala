# Feature: p0-catalogos

## Objective

P0 Catálogos CRUD (docs/scope.md §3.1 — COMPLETAR): online admin CRUD for municipio, localidad, categoria_producto, unidad in the new stack, Admin-only, with soft-delete/restore (estado) and outbox propagation so every client receives changes via PULL. Legacy admin CRUD was mocked in the UI — this module completes it for real.

## Problem / Why

Catalog management is P0 and unblocks productos/publicaciones/pedidos flows. The legacy UI mocked it (frontend-audit §10); the new system needs the real contract: online-confirm mutations (synchronization.md §9) that write the outbox, propagating through PULL (no raw doc push for S1).

## Completed inline before this module (T1, 2026-11-17)

- DVM1 fix: dev-mode storage wrapped with wrappedValidateAjvStorage (ajv dep added); regression phases added to rxdb-check (valid accepted / invalid rejected — both PASS). User-reported browser error fixed.
- D-3 RESUELTA (usuario): IVA = 16% — recorded in docs/database.md (§4 pending-decision paragraph + §7 register) and docs/scope.md (Q-14 blocker note + P0 list annotation). Q-14 (rounding rule) remains open for the money module.
- check / lint / check-types clean after the fix.

## Authorized scope (mutation)

- packages/api (routers/catalogos.ts + index merge), apps/web (routes/catalogos.tsx or section in routes, nav link, admin-gated UI, Spanish copy), minimal reuse of existing auth/sync infra.
- NO Prisma schema changes (tables exist). NO docs edits. legacy/** READ-ONLY.
- Deps: none expected (ajv already added; TanStack Query available).

## Route declaration

- T1 DVM1 + D-3 docs: inline (done).
- T2 catalogos module (router + UI + verification): DELEGATED single writer (2+ non-trivial files across packages).
- T3 parent gate + close: inline.

## TDD

Off (no runner). Functional checks: curl CRUD proofs (create/update/setEstado/restore as admin; 403 as agricultor), PULL propagation proof (old checkpoint → new doc arrives), check/lint/types clean, slice-e2e + rxdb-check still PASS, build OK.

## Delivery

Forecast: ~800-1200 authored lines. Strategy: ask-on-risk (default); agents create no commits (user-owned).

## Checklist

- [x] T1 DVM1 fix + D-3 recorded (inline) — 2026-11-17
- [x] T2 catalogos CRUD router + admin UI + verification (delegated)
- [x] T3 gate + close

## Acceptance criteria

- Admin can create/edit/deactivate/restore entries of the 4 catalogs from the UI with real persistence.
- Non-admin (agricultor) receives 403 on every mutation.
- Every mutation lands in sync_cambio (outbox) and a client pulling from a pre-mutation checkpoint receives the change (PULL propagation).
- check/lint/check-types clean; slice-e2e 12 PASS; rxdb-check 5 PASS (incl. DVM1); build OK.

## Progress

- T1 done 2026-11-17 (see above).
- T2 done 2026-11-17: catalogos.ts (16 procedimientos: {municipios,localidades,categorias,unidades}{List,Create,Update,SetEstado}) con patrón outbox de sync.ts (transacción única fila+sync_cambio, CAS updateMany version -> 409 CONFLICT, Admin-only ROLE.ADMIN, list para autenticados). UI /catalogos protegida con guard Solo Admin, secciones por catálogo, lectura desde live queries RxDB, papelera vía List(incluirInactivos), formulario que solo se limpia tras confirmación, toasts sonner, reSync tras mutación, sin borrado permanente. Header nav "Administración" solo Admin. use-database.ts hook extraído. Verificación: check/lint/types 6/6; create v1 + outbox SELECT-confirmado; update v2 + replay v1 -> 409; setEstado/restore v3/v4; fk inexistente 400; duplicado 409; Agricultor 403 "Solo el rol Admin puede modificar los catálogos"; PULL propagation probada (checkpoint 5 -> doc mutado v4, checkpoint 52); rxdb-check 5 PASS; slice-e2e ALL PHASES PASSED; build OK. Engram obs 944.
- T3 done 2026-11-17 (parent gate): role check (catalogos.ts:160) + patrón transaccional (145-147) grep-confirmados; check-types 6/6. Q-29 marcada RESUELTA en scope.md §3.2. Bloqueadores restantes mapeados: Productos Q-19; Usuarios/roles Q-05/Q-07; Pedidos/Pagos Q-14 (redondeo) + Q-06/Q-10; Publicaciones Q-25; Familias SIN bloqueadores -> siguiente módulo.
- Residuales: PULL con ventana de brechas puede retrasar hasta ~60s la entrega a OTROS clientes cuando hay gaps de seq (comportamiento normativo §4.2; refinamiento posible: escritura local optimista del row confirmado tras mutación online, o ventana más corta); formulario inline + window.confirm (packages/ui no exporta Dialog); unicidad de nombre forzada en código (sin constraint en DB; raza concurrente residual documentada); version inicial = 1 (desviación documentada vs enunciado; necesaria para CAS de push).
