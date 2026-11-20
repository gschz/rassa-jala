# Feature: p0-pagos

## Objective

P0 Pagos y operaciones financieras núcleo (docs/scope.md §3.1 — CONSERVAR reforzado): payment registration with monto == pedido.total (F-05), ONE pago per pedido (F-06, UNIQUE), folio advisory-locked (F-07 pattern), recibo 1:1, estado transitions Pendiente→Confirmado (+ Entregado), credit release on payment (Q-10 refinement), duplicate-op control (F-13/F-14 legacy fix). Cortes de caja y liquidaciones quedan para la feature P1 siguiente.

## Problem / Why

Payment is the financial integrity keystone: legacy enforced monto==total and one-pago-per-pedido ONLY in app code (F-05/F-06) — v2 must enforce them at DB level (UNIQUE + CHECK) and transactionally. The pedidos module left the state machine without an advance procedure; pagos adds confirmado (on payment) and entregado (seller/admin marks delivery).

## Business decisions applied (scope.md §3.2)

- Q-14: money via money.ts (integer-cents HALF_UP); pago.monto is a SNAPSHOT equal to pedido.total at payment time (never recomputed); históricos never re-touched.
- Q-10 refinement: credit usage counts ONLY estado='Pendiente' (unpaid) non-cancelled orders — paying releases credit (usage recompute in pedidos adjudication reads the same rule).
- Idempotency/duplicates: pago creation idempotent via sync_operacion + UNIQUE fk_pedido (replay → same result, no duplicates); folio sequence under pg_advisory_xact_lock.

## Authorized scope (mutation)

- packages/db: pago model (fk_pedido UNIQUE + CHECK monto > 0, folio varchar unique, metodo?/tipo_pago reference?, version, actualizado_en, creado_en, legacy_id?), recibo model (fk_pago UNIQUE 1:1, datos snapshot, emitido_en, legacy_id?), folio counter table (name + value) or equivalent, estado transitions (no schema change), migration + seed (tipo_pago lookup? check database.md §6 — tipo_pago exists in legacy: seed if the pagos UI needs it).
- packages/api: pagos router (registrarPago seller/admin with monto==total enforcement + folio + recibo in ONE tx + estado→Confirmado + historial; marcarEntregado seller/admin; list/detail scoped; receipt data read) + credit-usage refinement in pedidos adjudication (usage = estado 'Pendiente' only) + estado-advance helper shared.
- apps/web: /pedidos-vendedor + /pedidos-admin gain "Registrar pago" (online-confirm only, disabled offline) + "Entregado" actions; client /mis-pedidos shows paid/delivered badges + recibo view (printable-ish page or modal — minimal); recibo display route or modal.
- docs/database.md: M-13 (pago/recibo/folio + credit refinement) with 8-point justification. NOT legacy/**, NOT other docs.

## Route declaration

- T1 tracker: inline (done).
- T2 pagos module: DELEGATED single writer.
- T3 gate + close: inline.

## TDD

Off (no runner). Functional checks: monto mismatch 400, duplicate pago 409/no-op, folio sequential under parallel payments (distinct, monotonic), estado+historial transitions, credit released after pago (new order over old limit now fits), recibo 1:1 + data snapshot, role 403s (client cannot register pago), idempotent replay (PG counts unchanged), suites green, lint/build.

## Delivery

Forecast: ~1200-1600 authored lines. Strategy: ask-on-risk (default); agents create no commits (user-owned).

## Checklist

- [x] T1 tracker — 2026-11-18
- [x] T2 pagos module (delegated) — 2026-11-19
- [x] T3 gate + close — 2026-11-19

## Acceptance criteria

- ONE pago per pedido enforced at DB level; monto == pedido.total enforced (mismatch 400; CHECK in DB).
- Folio unique + monotonic under concurrency (advisory lock; parallel payments get distinct folios).
- Payment transitions pedido → Confirmado with historial + outbox in the same tx; recibo 1:1 with snapshot data.
- Credit released after payment (usage counts only 'Pendiente' non-cancelled) — proven by a new order fitting the old limit.
- Entregado transition (seller/admin) with historial.
- Online-confirm only: no pago push; UI disables offline.
- check/lint/check-types clean; suites green (pedidos-e2e + all prior + slice 9 points + rxdb-check); build OK.

## Progress

- T1 done 2026-11-18 (tracker created; pedidos closed with ~50 proofs).
- T2 done 2026-11-19 (pagos.prisma schema, seed, pedidos credit release calculation refined to 'pendiente' only, pagosRouter with advisory-locked folios and snapshot receipts, Web UI with payment registration, delivery, and receipt modals, database.md M-13 documented).
- T3 done 2026-11-19 (migration `20261119205050_add_pagos_base` applied with CHECK `pago_monto_positivo`, seed ×2 idempotent, decision Opción A implemented blocking cancel on paid orders with 409 and FOR UPDATE concurrency lock, 15/15 tests in `apps/web/e2e/pagos.test.ts`, root test suite 93/93 pass ×2, rxdb-check 5 pass, slice-e2e 9 points pass, check/lint/check-types/build clean).
