# Feature: p0-familias

## Objective

P0 Familias y permisos (docs/scope.md §3.1 — CONSERVAR reforzado): family admin CRUD + memberships (one active per user, F-09), credit limits with single owner familia|usuario (Q-10), family-chat record integration (minimal, idempotent), role permissions, plus token-estado hardening (deactivated user cannot operate with a valid token). In parallel: read-only data-quality review of the delivered legacy DB (Q-21/Q-27).

## Problem / Why

Families are the credit and community backbone; pedidos/pagos modules depend on their model. Legacy had no DB-level one-active-membership protection (serializer-only, F-09) and a user-only credit model (Q-10 changes this by decision).

## Business decisions adopted (user, 2026-11-17 — recorded in scope.md §3.2)

- Q-10: new entity `limite_credito` with EXACTLY one owner (fk_familia XOR fk_usuario), unique per owner; no limit assigned → no credit orders (enforced later in pedidos); utilization considers pending non-cancelled orders (implemented in pedidos module, not here).
- Q-21: partial UNIQUE on familia_usuario (fk_usuario WHERE estado=true) + transactional server validation. Delivered data confirmed WITHOUT duplicate active memberships (database.md §3.1).
- Q-05/Q-07/Q-06/Q-19/Q-25/Q-14: recorded in scope.md §3.2 (affect later modules).
- Token-estado: protectedProcedure must verify usuario.estado per request (extends F-01 beyond login).

## Authorized scope (mutation)

- packages/db: new models (familia, familia_usuario, limite_credito; conversacion/integrantes minimal for family-chat), migration(s), seed update (sample family + members + limit), via `prisma migrate dev`.
- packages/api: familias router + protectedProcedure estado hardening.
- apps/web: /familias admin page (members, jefe, limit) + user's own family display (minimal) + RxDB collections/replication scoping per database.md §6.2.
- docs/database.md: M-register additions for THIS module's schema changes (M-8/M-9 style, with the 8-point justification) + §6.2 row adjustments if collection granularity differs.
- legacy/** READ-ONLY. No other docs edits.

## Route declaration

- T1 recon + decisions recorded: inline (done).
- T2 familias module: DELEGATED single writer (cross-package, 2+ non-trivial files).
- T3 data-quality review Q-21/Q-27: DELEGATED read-only worker (no file edits; findings → engram).
- T4 integrate findings into database.md + gate: inline/small writer after T2+T3.
- T5 close: inline.

## TDD

Off (no runner). Functional checks: curl-level proofs (one-active rule incl. concurrent attempt, baja/restore, jefe guards, limite XOR uniqueness, role 403s, deactivated-token 401, PULL scoping per role), suites green (slice-e2e, rxdb-check, build), lint/check/types clean.

## Delivery

Forecast: ~1200-1600 authored lines. Strategy: ask-on-risk (default); agents create no commits (user-owned).

## Checklist

- [x] T1 recon + decisions recorded in scope.md (Q-05/06/07/10/14/19/25; entregable académico note) — 2026-11-17
- [ ] T2 familias module (delegated)
- [x] T3 data-quality review (delegated, read-only)
- [x] T4 findings integrated into database.md + parent gate
- [x] T5 close

## Acceptance criteria

- One active membership per user enforced by BOTH server transaction and DB partial unique index (concurrent attempt safe).
- limite_credito with exactly-one-owner XOR + per-owner uniqueness; admin CRUD; no-limit → no credit orders documented for pedidos module.
- Family creation transactionally creates familia + jefe membership + family conversation (idempotent upsert).
- Deactivated user's valid token rejected on protected procedures.
- Role permissions verified (Admin mutations; agricultor/vendedor 403; member reads own family only — PULL scoping proof).
- Data-quality review delivered read-only with classified findings (no cleanups).
- check/lint/check-types clean; suites green; build OK.

## Progress

- T1 done 2026-11-17: PDF reference exists (docs/reference/RASSA_JALA_BD_Documento_Tecnico_v3.pdf); model rows located in database.md (familia/familia_usuario/limite_cliente/conversacion §3.1+§6.2); delivered data confirmed without duplicate active memberships; scope.md updated with all business decisions.
- T2 done 2026-11-17: familias module complete — models familia/familia_usuario/limite_credito/conversacion/integrantes (migration 20261117233355_add_familias_base con SQL crudo: UNIQUE parcial fk_usuario WHERE estado=true, CHECK XOR propietario, CHECK monto>=0, parciales por propietario); protectedProcedure endurecido (usuario.estado por llamada -> 401 'Usuario desactivado'); familias.ts con list/create/addMember/removeMember/restoreMember/setJefe/setLimite/setEstado (transacción única fila+outbox, CAS, Admin-only); sync +3 colecciones PULL con scoping (familias/membresias/limites_credito — doc-deviation documentada en database.md §6.2 + M-9); /familias admin + tarjeta propia en /. Verificación: familias-e2e ALL PROOFS (tx 5 filas + 4 outbox; concurrencia 1×200+1×409; baja/restore; jefe 400; XOR 400; monto negativo 400; Agricultor/Vendedor 403; token desactivado 401; scoping PULL por rol); rxdb-check 5 PASS; slice-e2e 12 PASS; build OK; check/lint/types 6/6. Engram obs 948. Docs: M-8 (limite_credito Q-10) y M-9 ADOPTADAS en database.md §7.
- T3 done 2026-11-17: revisión solo-lectura Q-21/Q-27 (obs 947) — 11/11 sin huérfanos, Q-21 limpia, stock OK, recibos 1:1; 1 SEVERE (fk_pago_liquidacion compartido liq 1 y 5) + 6 MEDIUM documentados; tratamientos propuestos sin ejecutar.
- T4 done 2026-11-17 (parent gate): hallazgos integrados como database.md §4.7 (clasificados, con nota expresa de re-verificación del SEVERE antes del import); constraints grep-confirmados en la migración; check-types 6/6.
- T5 done 2026-11-17: espejo + resumen + informe. Commits propiedad del usuario.
- Residuales: aprovisionamiento de usuarios pendiente (siguiente módulo Usuarios y roles; usuarios de prueba acotados en seed); tabla mensaje diferida (chat P1); purga local al cambio de usuario (sync §11) no implementada aún (lecturas con scoping por identidad — sin fuga); dev-deliverable pendiente: reporte técnico con capturas al cierre.
