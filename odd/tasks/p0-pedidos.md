# Feature: p0-pedidos

## Objective

P0 Pedidos (docs/scope.md §3.1 — COMPLETAR): the order lifecycle online-first AND offline-queued — cart → checkout → server adjudication (stock + credit, Q-10) → atomic seller claim (Q-06) → estados/historial → clientes físicos (PDF §6-7/22-23) → idempotency. The financial heart: money math centralized server-side (Q-14), PostgreSQL integrity protected.

## Problem / Why

Pedidos is the core commercial transaction; legacy enforced its invariants ONLY in app code (F-05..F-07) with client-only idempotency (F-13/F-14). The new system must move integrity server-side (DB CHECKs + transactional adjudication) while keeping the offline-first UX (creation queued locally, never shown as confirmed until the server verdict).

## Business decisions applied (scope.md §3.2)

- Q-06: fk_vendedor NULL at creation; active Vendedores consult available orders and claim ATOMICALLY (one winner); only the assigned seller operates; Admin may reassign; in-person orders auto-assign the creating seller.
- Q-10: credit consumption = sum of pending-payment non-cancelled orders vs limite_credito (family XOR individual owner); user without limit → cannot order on credit (clear error); computed transactionally.
- Q-14: subtotal = Σ importe (precio_unitario × cantidad, 2 decimals); IVA = HALF_UP(subtotal × 0.16, 2); total = subtotal + IVA; snapshots persisted on the order; NEVER float/Number; centralized in a shared money helper; históricos never recomputed.
- Stock: INTEGER; decrement at order application; restore on cancel; insufficient stock → order rejected with motivo.
- Clientes físicos (PDF): seller creates orders for account-less persons (nombre + teléfono opcional); fk_cliente NULL; does NOT consume family credit; stock/amounts/history rules intact.

## Authorized scope (mutation)

- packages/db: estado_pedido lookup (+seed from database.md §6 enumerations), pedido_cabecera (fk_cliente nullable, fk_vendedor nullable, fk_estado → estado_pedido, subtotal/iva/total snapshots numeric(12,2), origen ('digital'|'presencial'), cliente_nombre/cliente_telefono nullable — M-12 justification, version, actualizado_en, estado, legacy_id?), detalle_pedido (fk_pedido, fk_producto_semanal, cantidad CHECK > 0, precio_unitario snapshot numeric(10,2), importe snapshot numeric(12,2), version, actualizado_en), historial_estado_pedido (append-only: fk_pedido, fk_estado, fecha, actor nullable). Migration + seed. NO pago/recibo/folio tables (next module).
- packages/api: money helper (shared, no deps, integer-cents HALF_UP) + pedidos router (checkout online for connected clients; misPedidos; detalle w/ historial; claimar; reasignar (admin); cancelar (client if pending + seller/admin per legacy rules — read database.md business rules first); pedidoPresencial (seller)) + sync push for pedidos/detalle (S2 adjudication) + pull scoping (client: own; seller: assigned + available? read-only avail via procedure, not PULL — available orders are dynamic; decide: PULL only OWN (assigned to me or mine); available-list via online procedure) + estado_pedido PULL lookup.
- apps/web: /catalogo gains cart (RxDB LOCAL collection — no replication) + checkout (offline-capable: local order doc pending → push adjudication; pending NEVER shown as confirmed), /mis-pedidos (client: orders + estado + historial view), /pedidos-vendedor (seller: available + claim + mine + in-person create), admin: all orders + reassign in /pedidos-admin (or extend /mis-pedidos admin view — keep pages minimal).
- docs/database.md: M-12 (+ any nuance M-13) + §6.2 rows for new collections. NOT legacy/**, NOT other docs.

## Route declaration

- T1 tracker: inline (done).
- T2 pedidos module: DELEGATED single writer.
- T3 gate + close: inline.

## TDD

Off (no runner). Functional checks: money proofs (exact HALF_UP case), stock decrement/insufficient-reject/restore-on-cancel, credit family/individual/no-limit/over-limit, claim race (parallel claims → 1 winner), in-person (no credit), idempotent replay (PG counts unchanged), historial appended per transition, role 403s, offline pending → push verdict clears, suites green, lint/build.

## Delivery

Forecast: ~1800-2400 authored lines. Strategy: ask-on-risk (default); agents create no commits (user-owned).

## Checklist

- [x] T1 tracker — 2026-11-18
- [x] T2 pedidos module (delegated)
- [x] T3 gate + close

## Acceptance criteria

- Checkout offline: order created locally (pendiente de confirmación) → push → server adjudicates (stock + credit + items valid) → aplicada/rechazada with motivo; pending never shown as confirmed; idempotent replay.
- Money snapshots exact (HALF_UP IVA 16% over full subtotal) persisted on pedido.
- Stock decremented in-tx; insufficient → rejected; cancel restores.
- Credit: family owner consumes shared limit; individual owner consumes own; no limit → rejected with clear message; over-limit → rejected.
- Claim: parallel claims → exactly 1 winner; only assignee operates; admin reassign; in-person auto-assign + no credit.
- Historial appended per transition (server-only writes); visible in order detail (scoped).
- Roles: client/seller/admin boundaries enforced (403s proven).
- check/lint/check-types clean; suites green (all previous e2e + slice 9 points + rxdb-check); build OK.

## Progress

- T1 done 2026-11-18 (tracker created; publicaciones closed with 24+push proofs).
- T2 done 2026-11-18 (retry — el primer intento murió sin escribir nada): pedidos module complete — estado_pedido (7 valores exactos del modelo, outbox para S1), pedido_cabecera (fk_cliente/fk_vendedor nullable SetNull, snapshots numeric(12,2) con CHECK total=subtotal+iva y dinero>=0, origen CHECK digital|presencial, columnas cliente físico M-12), detalle_pedido (CHECK cantidad>0, snapshots precio/importe, nombre_producto), historial_estado_pedido append-only (sin ruta de update en el código); money.ts (centavos enteros, HALF_UP 16% sin deps); pedidos.ts con adjudicación central ÚNICA (advisory lock 'pedidos_adjudicacion' → items → money → crédito → stock → pedido+detalles+historial+outbox en una tx; centinela Rechazo revierte decrementos parciales); procedimientos checkout/pedidoPresencial/claimar/reasignar/cancelar/misPedidos/disponibles/detalle/list + sync push de creación (server ignora estado/totals del cliente) + pulls con scoping. Web: carrito RxDB local sin replicación + estimado en /catalogo, checkout offline en cola con 'Pendiente de confirmación' hasta veredicto, /mis-pedidos con historial, /pedidos-vendedor (Disponibles/Míos/Presencial + claim), /pedidos-admin (filtros + reasignar). Verificación: pedidos-e2e ~50 checks ALL PASS (dinero exacto 60.78/9.72/70.50; stock 9,8,7 + rechazo sin filas; crédito familiar acumulada 141.00 de 200.00 + sin-límite + individual + presencial sin crédito; claim race 1×200+1×409; cancel restaura stock + historial; replay idempotente PG sin cambios; 403s; scoping). rxdb-check 5 PASS; slice-e2e ALL PHASES; todas las e2e previas ALL PASS; check/lint/types/build 6/6 limpios. Engram obs 961.
- T3 done 2026-11-18 (parent gate): CHECKs de dinero grep-confirmados en la migración (líneas 130/132); check-types 6/6. Commits propiedad del usuario.
- Residuales: sin procedimiento de avance de estado (pendiente→confirmado→entregado llega con p0-pagos); uso de crédito cuenta todos los no-cancelados (refinamiento pagado llega con pagos); fixture e2e usa agricultor dedicado por SQL (Monday gate bloquea publicación por API en no-lunes); suites /tmp parcheadas para paginación con ventana de brechas; aprendizaje crítico: RxDB free tier limita ~13 colecciones abiertas (COL23) — los próximos módulos deben planificar colecciones (compartir/embed en lugar de abrir más).
- Siguiente: p0-pagos (pago único por pedido + monto==total, folio advisory-locked, recibo 1:1, confirmado/entregado, liberación de crédito al pagar, idempotencia).
