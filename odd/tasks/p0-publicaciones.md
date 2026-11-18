# Feature: p0-publicaciones

## Objective

P0 Publicaciones semanales (docs/scope.md §3.1 — COMPLETAR/CORREGIR per Q-19/Q-25): the weekly cycle for Agricultor (publicacion_semanal + producto_semanal with price/stock/photos), S2 offline drafts via RxDB push with server-side domain validation, Monday-only publication gate in America/Mazatlan, and the weekly catalog view for Cliente. This is the FIRST collection class with real offline writes beyond the localidades mechanism demo.

## Problem / Why

The commercial heart of RassaJala: farmers publish weekly offers; buyers browse and (later, pedidos module) order. Legacy had Monday-gated publication with per-item server validation; the new system must reproduce it offline-first without faking confirmation states.

## Business decisions applied (scope.md §3.2)

- Q-19: producto_semanal managed by its Agricultor (price, stock integer, unidad, photos); producto maestro remains Admin-owned.
- Q-25: ISO 8601 calendar with weeks 1–53; ciclo identified by its Monday date; uniqueness (agricultor, fecha de ciclo); semana_iso/anio_iso derived from the ciclo date; publication ONLY on Mondays in America/Mazatlan; do not confuse weekly numbering with liquidaciones periods.
- Q-14 (money): prices numeric(10,2) 2-decimals; totals computed later in pedidos module (snapshot rules) — here only unit price validation (>= 0).
- Stock: INTEGER quantities (PDF said NUMERIC(12,2) — decision: integer until business confirms fractional sales).

## Authorized scope (mutation)

- packages/db: publicacion_semanal + producto_semanal models; producto_imagen gains fk_producto_semanal (nullable, XOR CHECK exactly-one-target + per-owner principal partial uniques) — M-11 in database.md §7 with 8-point justification; migration + seed.
- packages/api: publicaciones router (farmer CRUD drafts + publish transition Monday-gated + buyer catalog read) + sync push for the new S2 collections + sync pull scoping (agricultor: propias; cliente: publicado semana actual; admin: todas).
- apps/web: /publicaciones (Agricultor, offline-capable drafts), /catalogo (Cliente: current week offers, category filter + search), replication push wiring for S2, nav.
- docs/database.md: M-11 + §6.2 row adjustments for the new collections. NOT legacy/**, NOT other docs.

## Route declaration

- T1 tracker: inline (done).
- T2 publicaciones module: DELEGATED single writer.
- T3 gate + close: inline.

## TDD

Off (no runner). Functional checks: curl + RxDB e2e (draft offline → push applies; publish Monday-gated behavior per actual day; buyer sees only published current week; scoping; idempotent replay; stock/price validation), suites green, lint/build.

## Delivery

Forecast: ~1500-2000 authored lines. Strategy: ask-on-risk (default); agents create no commits (user-owned).

## Checklist

- [x] T1 tracker — 2026-11-18
- [x] T2 publicaciones module (delegated)
- [x] T3 gate + close

## Acceptance criteria

- Agricultor creates offline draft publication + items in RxDB; PUSH applies them idempotently (server validates stock>=0, price>=0, maestro producto exists+active, ciclo = ISO Monday date); replay safe.
- Publish transition: borrador→publicado ONLY on Monday (America/Mazatlan) and only for the current ciclo; otherwise clear error; cancelado/cerrado states per legacy lifecycle (borrador→publicado→cerrado; cancelado).
- Cliente sees ONLY published current-week offers (scoping proof); Agricultor sees own (all weeks); Admin sees all.
- Photos: upload online-only via adapter; semanal images use producto_imagen XOR target (M-11).
- check/lint/check-types clean; suites green (slice-e2e, rxdb-check, productos/familias/usuarios e2e); build OK.

## Progress

- T1 done 2026-11-18 (tracker created; productos closed with 28 proofs).
- T2 done 2026-11-18: publicaciones module complete — publicacion_semanal (ciclo = fecha de lunes DATE, UNIQUE parcial (fk_agricultor, fecha_ciclo) — cancelado excluido para re-draft; semana_iso/anio_iso derivados + CHECK 1-53; estado domain CHECK borrador/publicado/cancelado/cerrado) + producto_semanal (precio Decimal(10,2) CHECK >=0, stock Int CHECK >=0, UNIQUE parcial (fk_publicacion, fk_producto) WHERE activo) + M-11 producto_imagen XOR target con parciales por dueño; helper compartido iso-semana.ts (Intl Mazatlan; 11/11 asserts incl. año de 53 semanas y frontera de año); publicacionesRouter (misPublicaciones/detalle/crearBorrador/agregarItem/editarItem/quitarItem/publicar/cancelar/cerrar/catalogoCliente/imagenes.*) + sync pull/push S2 (push solo borrador farmer-owned con veredictos + idempotencia sync_operacion; publicar/cancelar/cerrar = online-confirm). Web: /publicaciones (borradores offline con marcador pendiente; Publicar/Cancelar/Cerrar + fotos solo online; error exacto del Monday-gate visible), /catalogo (Cliente: ofertas del ciclo activo, filtro categoría, búsqueda, Agotado). Verificación: publicaciones-e2e 24/24 PASS (incl. cross-source duplicate 409, non-Monday 400, past-Monday 409 determinista, Pu4 stock/precio 0 bloqueados al publicar, 403s); publicaciones-push-e2e ALL PASS (draft offline → push aplicada → carrera item-push converge con retry 5xx → PULL limpia pendiente → replay idempotente PG sin cambios; maestro inactivo → rechazada; estado publicado → rechazada sin filas fantasma); scoping: cliente solo publicado-actual, agricultor solo propias (hueco detectado y corregido); rxdb-check 5 PASS; slice-e2e ALL PASS; productos/usuarios/familias e2e + role-freshness ALL PASS; build OK; check/lint/types 6/6. Engram obs 957.
- T3 done 2026-11-18 (parent gate + docs): synchronization.md §9 actualizado (push de borradores ya no es "decisión futura": implementado p0-publicaciones); check-types 6/6. Commits propiedad del usuario.
- Residuales: cerrar (éxito) solo demostrable en un lunes real (hoy probado el 400-negativo); items huérfanos de una pub rechazada reintentan indefinidamente (visible en error$; shortcut comentado); delete de foto de item no implementado (solo upload/setPrincipal); defectos legacy NO heredados documentados (unicidad excluye cancelado; publicar ya no exige fotos).
- Siguiente: p0-pedidos (carrito→checkout→stock/crédito/reclamo/estados-historial/clientes físicos/idempotencia).
