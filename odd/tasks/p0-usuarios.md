# Feature: p0-usuarios

## Objective

P0 Usuarios y roles (docs/scope.md §3.1 — CORREGIR): public registration (Cliente only), admin user management with role assignment, controlled provisioning of Vendedor/Agricultor, deactivate/reactivate with session revocation, profile self-service, secure initial-password mechanism with forced change (Q-05/Q-07 — no email, no plaintext temps).

## Problem / Why

Families/credit/orders all reference users; provisioning was undefined in legacy (Q-05/Q-06 audit gaps) and role vocabulary conflicted across layers (F-26). The new system needs a single canonical role model and admin-controlled lifecycle.

## Business decisions applied (scope.md §3.2, user 2026-11-17)

- Q-05: register → Cliente; Vendedor/Agricultor provisioned by Admin only; nobody self-escalates.
- Q-07: no email flows; login + change password + admin-controlled reset; admin-created accounts get a secure initial password + forced change; never store/distribute plaintext temps.

## Authorized scope (mutation)

- packages/db: usuario.debe_cambiar_password column (migration) + seed additions (vendedor/agricultor test users).
- packages/api: usuarios router (list/detail/create/changeRol/setEstado/resetPassword/register/profile update) + auth hardening (refresh rejects estado=false + deactivation revokes refresh tokens + debeCambiarPassword gate in protectedProcedure).
- apps/web: /registro (public), /perfil, /usuarios (admin), forced-change flow, header nav.
- legacy/** READ-ONLY; no docs edits beyond none needed (no schema-model decision changes — debe_cambiar_password is an implementation detail; if the worker deems it a model change worth recording, add a one-line M-10 in database.md).

## Route declaration

- T1 tracker: inline (done).
- T2 usuarios module: DELEGATED single writer (cross-package; proven pattern).
- T3 parent gate + close: inline.

## TDD

Off (no runner). Functional checks: curl proofs (register→Cliente; provisioning with one-time password; forced-change gate 403→change→allowed; changeRol; deactivate→token 401+refresh rejected+tokens revoked; last-admin guard; no self-escalation; resetPassword; scoping PULL), suites green, lint/check/types clean, build OK.

## Delivery

Forecast: ~1000-1400 authored lines. Strategy: ask-on-risk (default); agents create no commits (user-owned).

## Checklist

- [x] T1 tracker — 2026-11-17
- [x] T2 usuarios module (delegated)
- [x] T3 gate + close

## Acceptance criteria

- Public register creates active Cliente (validates active localidad; duplicate email 409).
- Admin creates users with role; generated/initial password shown ONCE; debe_cambiar_password=true; forced-change gate blocks other operations (403) until changed; no plaintext anywhere (hash only).
- changeRol/setEstado Admin-only with guards: no self role-change/deactivation; last-active-admin protection.
- Deactivation revokes the user's refresh tokens immediately; refresh rejects estado=false; valid access token already fails via protectedProcedure (proven in p0-familias).
- resetPassword: old password invalid, new works, forced change again, sessions revoked.
- Profile self-edit limited to persona fields (+ active-localidad validation); email/rol not self-editable.
- PULL scoping: admin all; non-admin self + own-family members.
- check/lint/check-types clean; slice-e2e + familias suites + rxdb-check green; build OK.

## Progress

- T1 done 2026-11-17 (tracker created; parent committed previous modules).
- T2 done 2026-11-17: usuarios module complete — usuarios.{register(public→Cliente), list, detail, create(generate:true → passwordInicial una sola vez), changeRol, setEstado(revocación de refresh tokens en la misma tx), resetPassword, updatePerfil}; protectedProcedure con puerta de cambio obligatorio (allowlist auth.me/changePassword/logout; 403 'Debe cambiar su contraseña antes de continuar'); login/refresh exponen debeCambiarPassword; sync.usuarios.pull con scoping (admin: todos; no-admin: self + familia propia; sin passwordHash en docs); /registro público (localidadesPublicas), /perfil, /usuarios admin, /cambiar-password con beforeLoad guard; columna usuario.debe_cambiar_password (migración 20261117235825, M-10 en database.md §7.1); seed +agricultor2. Verificación del worker: usuarios-e2e ALL PROOFS ×2 (register/outbox/dup 409/localidad 400; hash-only sin texto plano; gate 403→liberado tras cambio; self-changeRol 403; desactivación con tokens revocados en tx + token vigente 401 + refresh rechazado; resetPassword; scoping PULL). Engram obs 952.
- T3 done 2026-11-17 (parent gate + hardening): detecté residual de seguridad del worker (claim de rol en JWT obsoleto hasta re-login) → FIX: protectedProcedure ahora trae rol fresco de la BD en la misma consulta y sobreescribe ctx.user.rol (role freshness); auditoría adicional: changeRol NO tenía guard de último-Admin (dos Admins activos podían dejarse en cero secuencialmente) → FIX: guard de conteo + advisory lock pg_advisory_xact_lock compartido entre changeRol/setEstado (patrón folios F-07) cerrando también la carrera de desactivaciones mutuas; el guard 409 queda como defensa de integridad/carreras (la vía de claim obsoleto ahora muere antes con 403 de frescura — e2e actualizado a ese comportamiento). Prueba dirigida /tmp/opencode/role-freshness-check.ts: ALL PASS (downgrade → mismo token → 403 'Solo el rol Admin puede modificar los catálogos'). Batería: check/lint/types 6/6 (243 archivos); rxdb-check 5 PASS; usuarios-e2e ALL PROOFS; familias-e2e ALL PASS; slice-e2e ALL PHASES PASSED (9 puntos; re-run previo se colgó ~600s por la ventana de brechas tras la ráfaga de e2e concurrentes — normativo, pasó al reintentar); build OK (sw.js).
- Residuales: tras cambio forzado de contraseña el refresh cookie queda revocado por diseño (re-login tras expiración); no hay colección RxDB de usuarios en web (PULL server-side); reparación one-off de estado dev fuera de scripts; slice-e2e sensible a la ventana de brechas si corre inmediatamente tras ráfagas concurrentes (documentado).
