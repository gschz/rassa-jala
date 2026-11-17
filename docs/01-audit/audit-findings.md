# Audit Findings — Legacy RassaJala (consolidated)

Consolidated findings from the three primary audits (`backend-audit.md`,
`database-audit.md`, `frontend-audit.md`) plus the correspondence work in
`functional-map.md`. The purpose of this document is to give the reimplementation
(React + TS, Bun + tRPC, Prisma, Supabase Postgres, RxDB, offline-first PWA) a factual,
evidence-cited basis and an explicit register of what is unknown. The legacy tree is
**reference only**; nothing here designs or implements anything.

Evidence tags: **CONFIRMED** = backed by repo files (paths under `legacy/` with line
numbers, and/or audit-doc sections). **Inference** = labeled, with the evidence used,
never presented as fact.
Findings state implications only — no designs, no migrations, no data-model changes.

## Quick path

1. [Executive summary](#1-executive-summary) — what the legacy system is, in one screen.
2. [Confirmed findings](#2-confirmed-findings) — F-01…F-31, each with evidence and implication.
3. [Inferences register](#3-inferences-register) — labeled, never silently absorbed.
4. [Inconsistencies & contradictions](#4-inconsistencies--contradictions) — between apps, layers, and audits.
5. [Missing / ambiguous information register](#5-missing--ambiguous-information-register) — deduplicated, tagged.
6. [Offline-First considerations](#6-offline-first-considerations) — needs classification only (Analysis).
7. [Recommended next evidence steps](#7-recommended-next-evidence-steps) — read-only verification tasks.

---

## 1. Executive summary

RassaJala is a two-sided agricultural marketplace for Nayarit, México: farmers
(`Agricultor`) publish weekly offers of catalog products (`publicaciones` →
`producto_semanal`), clients (`Cliente`) order them (`pedidos`, with IVA 21 %, credit
limits extended across family members, and stock decrements), sellers (`Vendedor`)
advance orders, register cash payments (`pagos` with `REC-` folios), schedule pickups
(`recolecciones`) and close their cash drawer daily (`cortes`); an `Admin` manages
catalogs, users, farmer families (`familias`, each with a synced group chat), waste
(`mermas`) reports, and weekly farmer settlements (`liquidaciones`, 10 % commission,
snapshot-based, double-payment-guarded).

The backend is a Django 5 / DRF monolith (`legacy/rassa_back`) — WSGI only, no ASGI, no
scheduler, no email — with PostgreSQL ≥ 15 specifics baked in (`pg_advisory_xact_lock`
folios, `nulls_distinct` constraints, `SET LOCAL` lock timeouts, `select_for_update`
chains). Roles are data rows enforced through DRF permission classes; nearly all
integrity rules live in serializers and views, not the database (31 migrations
superseded the original 32-table SQL archive). Product images live in Google Drive via
two parallel upload pipelines with an orphan-cleanup state machine.

The frontend is a monorepo (`legacy/rassa_front`): an Expo/React Native app (~45 screens,
8 navigators) and a Vite/React 19 web app (~60 route registrations), sharing `@rassa/chat`
and `@rassa/common`. Both are react-query + zustand + axios stacks with **UI-only offline
behavior** (banners; no service worker, no queue, no sync) and **polling-only chat**.
Both apps carry extensive client-side checkout/payment idempotency machinery — while the
backend never reads the `Idempotency-Key` header they send.

Materially: admin product/category/unit CRUD is faked in the UI, dashboards are mocked,
several backend capabilities have no frontend at all (merma registration, settlement
calculation, recolección editing, the new image pipeline, the audit-log API), role
vocabularies differ across three layers, farmer product CRUD screens call Admin-only
endpoints, and the codebase carries a nontrivial dead-code inventory. Chat attachments
are served from Django media only under DEBUG; tokens are stored differently per app;
the server timezone (Argentina) contradicts the business geography (Nayarit).

## 2. Confirmed findings

### Authentication, identity, sessions

**F-01 — Login does not check `Usuario.estado`.**
Evidence: `legacy/rassa_back/rassa/auth_serializers.py:128-143` verifies only
`user.is_active`; backend-audit §10.1; deactivation is only a flag flip
(`legacy/rassa_back/rassa/admin_views.py:264-319`). Enforcement of `estado` is
inconsistent across modules (chat checks it; most resources do not).
Implication: the new app needs one explicit, uniform rule for what "deactivated" means
across login, tokens, and every resource.

**F-02 — Refresh-token rotation without post-rotation blacklist.**
Evidence: `ROTATE_REFRESH_TOKENS=True` with `BLACKLIST_AFTER_ROTATION` unset
(`legacy/rassa_back/rassa/settings.py:165-172`); backend-audit §10.2. Only
change-password blacklists a supplied refresh token.
Implication: rotated-out refresh tokens remain valid up to 7 days — the new session
model must define rotation/revocation semantics deliberately.

**F-03 — There is no logout endpoint.**
Evidence: backend-audit §2.3 (only blacklist trigger is change-password's optional
`refresh_token` field); the frontends "log out" purely client-side by clearing storage
(frontend-audit §4.3).
Implication: session termination is cosmetic today; the new design must decide whether
logout is real (server revocation) or client-side only.

**F-04 — Tokens are stored differently per app, with different failure modes.**
Evidence: mobile uses a storage facade over expo-secure-store (keys `access_token`,
`refresh_token` — `legacy/rassa_front/src/services/storage.ts`, frontend-audit §8.1);
web keeps access in `localStorage` and refresh in `sessionStorage` (lost on tab close,
frontend-audit §4.3/§8.1). Refresh-failure semantics already diverge (web distinguishes
fatal vs transient; mobile is binary).
Implication: token-lifetime UX differs per platform today; any rewrite must pick one
storage/refresh contract and accept the old behavior as two precedents, not a spec.

### Data integrity & financial invariants

**F-05 — Financial invariants are enforced only in application code.**
Evidence: database-audit §7.3.5 — `monto = pedido.total` (`legacy/rassa_back/rassa/blueprints/pagos/serializers.py:43-49`), one pago per pedido, `stock ≥ 0`, `precio > 0`,
`cantidad > 0`, `limite_cliente.monto ≥ 0`, `total = subtotal + iva` in `save()`
(`legacy/rassa_back/rassa/models.py:442-444`); the SQL archive's CHECK constraints were
not migrated (database-audit §1.1.3). The single surviving DB CHECK is
`check_semana_range` (`legacy/rassa_back/rassa/models.py:354-358`).
Implication: with multiple clients writing (including offline ones), these rules are
racing today; the reimplementation must decide per invariant whether it is
server-authoritative, DB-enforced, or both.

**F-06 — Stock can go negative in aggregate scenarios.**
Evidence: backend-audit §10.8 — checkout and merma each decrement under
`select_for_update` but only against the current value; no DB CHECK exists
(database-audit §2 `producto_semanal`).
Implication: oversell is possible across interleaved flows; stock semantics need a
single authoritative owner in the new system.

**F-07 — PostgreSQL-specific concurrency machinery is load-bearing.**
Evidence: `select_for_update` chains with fixed ordering (pedido create, pago, corte,
liquidaciones, recolecciones, set-principal, admin mutations — backend-audit §5
"Cross-cutting mechanics"); folio generation under `pg_advisory_xact_lock`
(`legacy/rassa_back/rassa/models.py:515-530`); `unique_pago_per_pedido` with
`nulls_distinct=True` requiring PG ≥ 15 (`legacy/rassa_back/rassa/checks.py:5-33`,
migration 0018); `SET LOCAL lock_timeout` / `statement_timeout`
(`legacy/rassa_back/rassa/blueprints/liquidaciones/views.py:238-242`,
`legacy/rassa_back/rassa/blueprints/recoleccion/views.py:315-371`); deadlock → 409 with
`Retry-After` (`liquidaciones/views.py:244-252`).
Implication: the new Postgres-based stack can keep these, but each must be a conscious
decision (Prisma exposes advisory locks and partial indexes only via raw SQL).

**F-08 — The SQL archive is superseded by the ORM, and CHECK constraints moved to
serializers.**
Evidence: database-audit §1.1 (six drift classes: auth columns, generated columns, CHECK
constraints, named indexes, nullability relaxations, uniqueness relaxations) and §5
(models-vs-migrations drift: none detected; CI enforces `makemigrations --check`).
Implication: the archived SQL is historical documentation only; the migration chain is
the only trustworthy schema history.

**F-09 — "One active family per user" is enforced only in a serializer.**
Evidence: `legacy/rassa_back/rassa/blueprints/familias/serializers.py:57-88`; no DB
unique on `familia_usuario.fk_usuario` (database-audit §1.1.6); restore's
`update_or_create` implies duplicates are expected
(`legacy/rassa_back/rassa/blueprints/familias/views.py:100-104`).
Implication: data can already contain duplicate memberships; the new schema's
uniqueness decision must account for existing data shape.

**F-10 — Two Google Drive image pipelines with divergent failure semantics, plus an
orphan-cleanup state machine.**
Evidence: backend-audit §10.3 and G1–G6 — blueprint `/imagenes/` (public immediately,
10 MB) vs legacy `/imagen/` (private-then-public after commit, 5 MB, syncs legacy
`producto.imagen`); blueprint deletion marks `eliminar_pendiente=True` on Drive failure
and hides the row (`legacy/rassa_back/rassa/blueprints/producto_imagen/views.py:243-295`),
while the legacy delete path hard-deletes the row even when the Drive delete failed
(`legacy/rassa_back/rassa/productos_views.py:292-333`); cleanup is a **manual**
command (`legacy/rassa_back/rassa/management/commands/cleanup_orphan_drive_files.py:1-79`);
Drive files are made public by design (G6).
Implication: file storage, orphan handling, and public-visibility posture are
unresolved design inputs for the new app; the two pipelines cannot both be "the"
reference.

**F-11 — No scheduler, no celery, no email anywhere.**
Evidence: backend-audit §6 (no in-repo cron/systemd/celery; `cleanup_orphan_drive_files`
is manual) and §7 (no email backend, no `send_mail` usage).
Implication: everything the legacy system does happens synchronously in request paths;
any async need in the new app is new capability, not a port.

### API contract shape

**F-12 — Response envelopes are mixed per endpoint, with no global contract.**
Evidence: backend-audit §3 (`_ok()`/`OkResponseMixin` envelope — except pagos, cortes,
producto-imagen, and `tipos-pago` plain array per
`legacy/rassa_back/rassa/blueprints/pagos/views.py:208-213`); spot check S9: GET
`/pedidos/` is a **raw** DRF page (`legacy/rassa_back/rassa/blueprints/pedido/views.py:63`);
spot check S8: liquidación errors are `_ok`-shaped on 400/404/409/500 with
`ok = status_code < 400` (`legacy/rassa_back/rassa/views.py:43-49`); frontend-audit §4.2
documents per-endpoint unwrapping including a waste-specific envelope.
Implication: there is no derivable global envelope rule; the new API must define one and
the old per-endpoint map is the only legacy truth.

**F-13 — `Idempotency-Key` headers are sent by both apps and never read by the backend.**
Evidence: frontend-audit §6 (header on POST `/pedidos/`, `/pagos/`, `/recolecciones/`);
spot check S2 (grep over `legacy/rassa_back/rassa/` — zero handling).
Implication: all checkout/payment duplicate protection is client-side; the server's real
defenses are locks + transactions. Offline-first writes must not assume the legacy
header did anything.

**F-14 — Checkout idempotency machinery is extensive in both apps, and its payment-side
keys are never cleaned up.**
Evidence: mobile in-flight persistence + reconciliation (frontend-audit §6.1, §6.2 —
spot-checked `legacy/rassa_front/src/screens/seller/PaymentScreen.tsx:47-54`); web
checkout guard with cross-tab lock, fingerprint-stable keys, ambiguous markers, late
success surfacing (frontend-audit §6.3); storage-key table §6.4 shows
`idem_pago_{orderId}` accumulates one entry per paid order forever in both apps (no
removal code found).
Implication: the accumulated keys are harmless-ish debris but evidence that client-side
idempotency was bolted on; the new offline-write design should own idempotency
server-side and treat these mechanics as requirements input, not code to port.

**F-15 — The frontend's own contract comments contradict the backend.**
Evidence: `legacy/rassa_front/web/src/services/settlements.ts:184-185` claims "business
errors arrive as ok:true on HTTP 400/409"; backend `_ok()` produces `ok:false` for
status ≥ 400 (spot check S8). Caller behavior (branch on HTTP status) is safe either way.
Implication: documentation-by-comment is untrustworthy here; contracts must be pinned by
tests, not comments.

### Frontend reality map

**F-16 — Admin CRUD for products, categories, and units is faked in the UI.**
Evidence: mobile `AdminProductsScreen` hardcoded (frontend-audit §3.3); web
`AdminProducts`/`AdminCategories`/`AdminUnits` render `AdminCrudTable` over hardcoded
data with zero API calls (frontend-audit §3.2/§10.2). Backend routes exist (Admin-write
for productos; `IsAdminOrReadOnly` catalogs) but are exercised by no admin UI.
Implication: the admin CRUD contract "visible" in the legacy UI does not exist as used;
the rewrite must decide whether these screens are features to build (against real
endpoints) or drop.

**F-17 — Farmer product CRUD screens call Admin-only endpoints.**
Evidence: farmer screens are REAL-calling (frontend-audit §3.3: mobile
`ProductListScreen`/`ProductFormScreen`, web `FarmerProducts`/`ProductFormModal` issue
POST/PUT/PATCH/DELETE on `/productos/`); backend writes are `IsAdminOrReadOnly`
(spot check S10: `legacy/rassa_back/rassa/productos_views.py:57,95,223`; semantics per
backend-audit §2.5). The backend audit's Agricultor role summary grants no product-write
rights.
Implication: either the deployed backend differs from this checkout or the farmer
product flow never worked against it — undecidable from the repo (registered as open
question Q-19). The new app must resolve who owns catalog-product CRUD before building
farmer screens.

**F-18 — Dashboards are mocked; no stats endpoints exist server-side.**
Evidence: frontend-audit §3.16 — mobile buyer/seller/admin stats come from
`legacy/rassa_front/src/services/mock/dashboard.ts` (file comment: replace when backend
endpoints exist); web admin dashboard stats hardcoded; no stats family in backend-audit
§3. Farmer home is the only REAL stat surface (counts from `/productos/` +
`/publicaciones/`).
Implication: every dashboard metric in the new app is a new API, not a port.

**F-19 — Notifications do not exist beyond a mobile stub.**
Evidence: frontend-audit §3.16/§10.2 — `NotificationsScreen` is a static placeholder;
web has no surface; no push, no endpoint anywhere.
Implication: notifications are greenfield for the rewrite.

**F-20 — Dead code inventory (CONFIRMED, grep-verified).**
Evidence: frontend-audit §9/§10.1 — `legacy/rassa_front/packages/api/` (third axios
factory, zero imports), `legacy/rassa_front/packages/design-tokens/` (zero imports),
`legacy/rassa_front/src/screens/admin/AdminDashboardScreen.tsx` and
`AdminUsersScreen.tsx` (never imported), unused mock exports
(`getFarmerStats`, `getFarmerProducts`, `getRecentSales`), empty
`legacy/rassa_front/src/components/ui/`, unimported web samples
`legacy/rassa_front/web/src/routes/admin.tsx`, unused `@root` alias. Backend side:
`Recibo` model with no API (database-audit §8.3), `estado_pedido.activo` seeded but
unused (backend-audit §10.17), `producto.imagen` / `unidad.tipo` legacy-compat columns
(database-audit §8.4), `fecha_expiracion` never set by the create flow so the expiry
check is dormant (backend-audit §10.7).
Implication: none of this is behavior to preserve; it is a map of what "looked like a
feature" but is not.

**F-21 — The two apps are parallel implementations, not one product.**
Evidence: frontend-audit §10.3 — three axios factories (two alive, semantics diverged:
fatal-vs-transient refresh and per-request retry window exist only on web), two CRUD
paradigms (generic `CrudListScreen` vs fake `AdminCrudTable`), two product-update verbs,
two localidades scoping conventions, two farmer-picker data sources, two wizard step
counts (5 vs 4), two profile implementations. Spot check S3 adds: two toggle URL shapes
(both functional).
Implication: "the legacy behavior" is often "one of two behaviors"; the rewrite must
pick per case, with these as the documented forks.

### Chat & offline

**F-22 — Chat is polling-only, with no local persistence.**
Evidence: frontend-audit §7.3 — refetchInterval 10 s → 60 s (conversations) and 5 s
(messages), focused-only, `refetchIntervalInBackground: false`; no websockets; backend
has no ASGI runtime (backend-audit §1); no chat storage beyond react-query memory cache
(frontend-audit §7.3 "Inference" — absence of any storage code).
Implication: the new app's realtime/offline chat posture is a design decision, with
polling as the only evidenced legacy contract.

**F-23 — Offline behavior is UI-only in both apps.**
Evidence: frontend-audit §8.2 — NetInfo banners block submits on mobile; web has no
service worker, no PWA manifest, no workbox (grep-confirmed); `useOnline` is consumed by
one screen only; the only "offline resilience" is react-query cache + axios-retry +
checkout reconciliation.
Implication: there is no sync layer to port; offline-first is a new capability, and the
checkout reconciliation machinery (F-14) is the closest legacy precedent.

**F-24 — Chat attachments are served by Django media only under DEBUG.**
Evidence: backend-audit §10.12 — the `/documentos/` mount exists only when
`settings.DEBUG` (`legacy/rassa_back/rassa/urls.py:176-177`); attachments live under
`MEDIA_ROOT/documentos/`; the `sanitizar_documentos` command exists because of
path/URL mismatches. Web dev proxies `/documentos` (frontend-audit §8.2 note).
Implication: attachment serving was never production-solved; binary storage strategy is
an open design input.

### Cross-cutting

**F-25 — Timezone conflict: es-ar locale/Argentina TZ vs Nayarit, México geography.**
Evidence: `legacy/rassa_back/rassa/settings.py:228-231` (`LANGUAGE_CODE=es-ar`,
`TIME_ZONE=America/Argentina/Buenos_Aires`) vs seed geography
(`legacy/rassa_back/rassa/management/commands/seed_rassa_data.py`, Nayarit municipios);
corte day boundaries computed in Django `TIME_ZONE` (`legacy/rassa_back/rassa/blueprints/cortes/views.py:71-75`);
database-audit §9.6.
Implication: "day" semantics for cortes/recolecciones/publications are ambiguous today;
the new app must define one timezone policy before porting date math.

**F-26 — Role vocabulary conflict across four layers.**
Evidence: DB `roles` rows (Spanish) + backend aliases
(`legacy/rassa_back/rassa/auth_serializers.py:24-36`) vs mobile canonical English
(`farmer|seller|admin|buyer`, unknown throws — `legacy/rassa_front/src/store/AuthContext.tsx`)
vs web canonical Spanish (`agricultor|vendedor|admin|cliente`, unknown defaults to
cliente — `legacy/rassa_front/web/src/types/index.ts`), plus two competing web `User`
types and per-call-site `id_usuario`/`id` mappers (frontend-audit §10.4).
Implication: role naming is a real decision with data implications (the DB contains the
Spanish strings); deny-by-default vs default-to-client behavior also differs per app.

**F-27 — Backend surfaces with no frontend caller (correspondence residue).**
Evidence: functional-map §4.4 — `GET /auth/health/`, the whole `/logs/` API,
`GET /admin/usuarios/{id}/`, the blueprint `/imagenes/` pipeline (incl.
`set-principal`), `POST /publicaciones/{id}/productos/{itemId}/restore/`,
`GET|PATCH /recolecciones/{id}/` (the edit path), `GET /cortes/{id}/`,
`POST /liquidaciones/calcular/`, all merma writes + `decisiones-merma` CRUD,
`GET /familias/miembros/{id}/`, `GET /chat/conversaciones/{id}/`, and the admin
family-chat resync endpoint.
Implication: features that exist server-side but were never productized (merma
registration, settlement calculation trigger, recolección editing) are half-built
capabilities whose product intent needs confirmation, not ports by default.

**F-28 — Frontend parameters the backend silently ignores.**
Evidence: spot check S5 — `GET /productos/?page_size=200` (web wizard picker) hits
default pagination with no `page_size_query_param`
(`legacy/rassa_back/rassa/productos_views.py:38`,
`legacy/rassa_back/rassa/blueprints/producto_imagen/views.py:48` is the only place the
param exists); spot check S2 — the `Idempotency-Key` header (F-13).
Implication: the legacy contract includes silent no-ops; a strict new API will surface
them as errors — intentional but a behavior change.

**F-29 — Money handling is stringly typed client-side with a duplicated tax rate.**
Evidence: API returns decimal strings; both apps render via `Number()`;
`IVA_RATE = 0.21` duplicated (`legacy/rassa_front/src/utils/money.ts:6` and
`legacy/rassa_front/web/src/constants/order.ts:10`, flagged as debt S-1; backend
`settings.IVA_RATE` is `Decimal` "0.21" — frontend-audit §10.5, §6.1/§6.3).
Implication: tax/rounding rules live in at least three places; the rewrite needs one
authoritative money module (client rounding rules unverified — open question Q-14).

**F-30 — Rate limiting is disabled during tests.**
Evidence: backend-audit §10.10 (`legacy/rassa_back/rassa/settings.py:215-217`).
Implication: throttling behavior was effectively untested; scope throttle rules
explicitly in the new API rather than inheriting the 20+ scopes blindly
(backend-audit §5 lists them).

**F-31 — Public trash reads are unauthenticated; repo hygiene drift exists.**
Evidence: backend-audit §10.11 (`PublicTrashList` is `AllowAny`); §10.4–6
(duplicate `ProductoImagenSerializer` class in two modules with different fields;
`legacy/rassa_back/rassa/admin_serializers.py` is a single physical line;
`logs/models.py` is empty while `Log` lives in `rassa/models.py`); §10.13 docs drift
(`POST /api/auth/login-api/` referenced by `legacy/rassa_back/docs/USUARIOS_PRUEBA.md`
does not exist; README scripts absent).
Implication: security posture (public soft-deleted catalog names) and documentation
trustworthiness both need deliberate handling in the rewrite.

## 3. Inferences register

Each item is an **Inference** — plausible from the cited evidence, not confirmed by
execution or a live system.

- **I-01 — Slash-less `GET /pedidos/{id}/historial` works via Django's append-slash
  redirect.** Evidence: route generated with trailing slash
  (`legacy/rassa_back/rassa/blueprints/pedido/urls.py:8-12`); `CommonMiddleware`
  installed (`legacy/rassa_back/rassa/settings.py:64`); `APPEND_SLASH` not overridden
  (default True). Redirect not executed/observed.
- **I-02 — Farmer writes to `/productos/` are rejected (403) at runtime.** Evidence:
  `IsAdminOrReadOnly` semantics (spot check S10 + backend-audit §2.5) vs farmer UI calls
  (F-17). Static analysis only; no request was executed.
- **I-03 — The production database is PostgreSQL ≥ 15.** Evidence: database-audit §8.1
  (psycopg2, deploy check `checks.py`, advisory locks, CI Postgres 16). No production
  config in-repo.
- **I-04 — The SQL archive was never the deployed runtime schema after July 2026.**
  Evidence: database-audit §8.2 (`db/archive/` placement, migration dates, runbook).
- **I-05 — `Recibo` is dead schema; the "recibo" the UI shows is `Pago` output.**
  Evidence: database-audit §8.3 (no serializer/view/route touches `recibo`; only the
  seed command writes it).
- **I-06 — `producto.imagen` and `unidad.tipo` are legacy-compat columns.** Evidence:
  database-audit §8.4 (synced only by the legacy pipeline/serializer).
- **I-07 — The system is single-tenant; role-filtered querysets are the only isolation.**
  Evidence: database-audit §8.5.
- **I-08 — `familia_usuario` duplicate rows already exist or are expected.** Evidence:
  no DB unique (database-audit §1.1.6) + restore's `update_or_create`
  (`legacy/rassa_back/rassa/blueprints/familias/views.py:100-104`).
- **I-09 — Polling cadence (10 s → 60 s conversations, 5 s messages, focused-only) is
  the de-facto realtime contract.** Evidence: frontend-audit §7.3 (code constants);
  backend has no push mechanism (backend-audit §1).
- **I-10 — The web checkout guard's ambiguous marker is the real duplicate-order safety
  net, not the header.** Evidence: frontend-audit §6.3 code comments (W-4) + spot check
  S2 (header ignored server-side).
- **I-11 — The mobile category/unit toggle (PATCH detail route with `{estado}`) works
  server-side because `estado` is a writable serializer field.** Evidence: spot check S3
  (`legacy/rassa_back/rassa/catalogos_serializers.py:50-57` — `estado` not in
  `read_only_fields`); static analysis only.
- **I-12 — Seller/admin `GET /pedidos/` lists are server-side role-scoped.** Evidence:
  frontend-audit §3.5 inference (no client-side scoping param) now confirmed by
  backend-audit §3.6 (role-filtered querysets, `legacy/rassa_back/rassa/blueprints/pedido/views.py:79-102`).

## 4. Inconsistencies & contradictions

### 4.1 Mobile vs web (same product, two behaviors)

| Topic                         | Mobile                                                                       | Web                                                                   | Evidence                               |
| ----------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| Product update verb           | PUT `/productos/{id}/`                                                       | PATCH `/productos/{id}/`                                              | frontend-audit §3.3                    |
| Role vocabulary               | English (`farmer…`), unknown throws                                          | Spanish (`agricultor…`), unknown → cliente                            | frontend-audit §10.4                   |
| Token storage                 | secure-store facade (both tokens durable)                                    | access in `localStorage`, refresh in `sessionStorage` (dies with tab) | frontend-audit §8.1                    |
| Refresh failure               | binary (logout)                                                              | fatal vs transient classes                                            | frontend-audit §4.3                    |
| Publication wizard            | 5 steps                                                                      | 4 steps                                                               | frontend-audit §3.4                    |
| Farmer picker (recolecciones) | `/admin/usuarios/?rol=Agricultor&estado=true`                                | `/recolecciones/agricultores/`                                        | frontend-audit §3.7                    |
| Localidades scoping           | `?municipio_id=`                                                             | `/municipios/{id}/localidades/`                                       | frontend-audit §3.2; spot checks S3/S4 |
| Toggle URL shape              | detail route (categorías/unidades) or `/estado/`                             | `/estado/` only                                                       | spot check S3                          |
| Buyer registration            | full form incl. password confirmation (13-field state; exact set unitemized) | buyer-only hardcoded role                                             | frontend-audit §3.1/§11.13             |
| Offline surface               | NetInfo banners on many screens                                              | one `useOnline` consumer                                              | frontend-audit §8.2                    |

### 4.2 Frontend vs backend (claims vs code)

| Claim (frontend)                                                          | Backend reality                         | Evidence                                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Idempotency-Key` protects checkout/payments                              | Header never read                       | spot check S2; frontend-audit §6                                                                                         |
| Liquidación errors arrive `ok:true` on 400/409                            | Envelope is `ok:false` for status ≥ 400 | `legacy/rassa_front/web/src/services/settlements.ts:184-185` vs `legacy/rassa_back/rassa/views.py:43-49` (spot check S8) |
| `?page_size=200` returns 200 products                                     | Param ignored; page size 20             | spot check S5                                                                                                            |
| Farmer can manage catalog products                                        | Writes are Admin-only                   | spot check S10; F-17                                                                                                     |
| `GET /pedidos/` handled as both `{results}` and wrapped across call sites | Response is raw DRF page                | spot check S9; frontend-audit §4.2 note                                                                                  |
| (inventory omission) `GET /localidades/trash/` unlisted                   | Used by mobile trash screen             | spot check S7 (`legacy/rassa_front/src/components/TrashListScreen.tsx:65`)                                               |

### 4.3 Backend audit blanket statements vs code

The backend audit's global envelope claim ("responses wrapped in `{ok,data,message}`")
does not hold for `GET /pedidos/` (raw page — spot check S9); its §3 exceptions list
(pagos/cortes/imagen/tipos-pago) was correct but incomplete. Flagged in
functional-map §4.3; the per-endpoint map there is authoritative.

### 4.4 Models vs migrations vs SQL archive

- Models vs migrations drift: **none detected** (database-audit §5, CI-enforced).
- Models vs SQL archive: **six drift classes** (database-audit §1.1) — the archive is
  superseded (F-08).
- Two DB paths disagree on delete-failure semantics for Drive images (F-10).
- `publicacion_semanal.semana` CHECK (1–52) vs liquidaciones ISO weeks 1–53 —
  different domains sharing a concept, conflict-by-design (database-audit §9.9).

### 4.5 Envelope chaos (consolidated)

Six patterns coexist: `{ok,data,message}`; raw DRF page; raw detail; plain array
(`/tipos-pago/`); envelope-on-error with `ok:false` (liquidaciones); waste-specific
envelope. Clients compensate with per-endpoint unwrappers and dual-unwrap walkers
(frontend-audit §4.2). Functional-map §4.3 is the reference map.

## 5. Missing / ambiguous information register

Deduplicated across the three audits and this audit's spot checks. Tags:
**backend-owned** (backend evidence must close it), **frontend-resolved** (closed by
frontend/backend cross-evidence during this audit), **needs maintainer input** (product
intent lives outside the repo), **needs deeper evidence** (repo cannot answer; targeted
investigation required).

Resolved during this audit (were open in the source audits): Q-01, Q-02, Q-03, Q-04.
Count: **33 register rows; 4 resolved here; 29 genuinely open** (22 tagged
`needs maintainer input`, 7 tagged `needs deeper evidence`).

| #    | Open question                                                             | Source                                    | Tag                    | Status / note                                                                                        |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Q-01 | Server handling of `Idempotency-Key`                                      | frontend-audit §11.6                      | backend-owned          | **Resolved**: header ignored (spot check S2 → F-13)                                                  |
| Q-02 | `/pedidos/{id}/historial` trailing-slash tolerance                        | frontend-audit §11.7                      | backend-owned          | **Resolved**: route has slash; tolerance via append-slash redirect is Inference I-01 (spot check S1) |
| Q-03 | `GET /pedidos/` envelope contract                                         | frontend-audit §11.8                      | backend-owned          | **Resolved**: raw DRF page (spot check S9)                                                           |
| Q-04 | Mobile `CrudListScreen` toggle mechanism                                  | frontend-audit §11.12                     | frontend-resolved      | **Resolved**: PATCH, two URL shapes, works server-side (spot checks S3, I-11)                        |
| Q-05 | How are Vendedores provisioned (no endpoint)?                             | backend-audit §11.1                       | needs maintainer input | Seed-only evidence                                                                                   |
| Q-06 | How is `fk_vendedor` assigned to pedidos?                                 | backend-audit §11.2                       | needs maintainer input | No write path in API                                                                                 |
| Q-07 | Email/reset/verification/invitation flows required?                       | backend-audit §11.3                       | needs maintainer input | None exist                                                                                           |
| Q-08 | Chat delivery expectations beyond polling                                 | backend-audit §11.4                       | needs deeper evidence  | Poll intervals evidenced (I-09); realtime intent unknown                                             |
| Q-09 | `Recibo`: dead code or product requirement?                               | backend-audit §11.5, database-audit §9.3  | needs maintainer input | No API writes/reads it                                                                               |
| Q-10 | `LimiteCliente` provisioning (no write API)                               | backend-audit §11.6                       | needs maintainer input | Seed-only                                                                                            |
| Q-11 | Bruno coverage holes (logs/health/legacy imagen) intentional?             | backend-audit §11.7                       | needs maintainer input | —                                                                                                    |
| Q-12 | Deployment topology (Docker, gunicorn config, prod CORS/media)            | backend-audit §11.8                       | needs maintainer input | All outside repo                                                                                     |
| Q-13 | Is SQLite ever a supported runtime?                                       | backend-audit §11.9                       | needs maintainer input | PG-specific features would degrade (F-07)                                                            |
| Q-14 | IVA rounding rules for `subtotal × 0.21`                                  | frontend-audit §11.2                      | needs deeper evidence  | Rate confirmed 0.21 both apps; rounding unverified (F-29)                                            |
| Q-15 | External API contract document existence                                  | backend-audit §11.10                      | needs maintainer input | No OpenAPI/schema in repo                                                                            |
| Q-16 | Family chat desync monitoring/repair                                      | backend-audit §11.11                      | needs maintainer input | Only manual `/sincronizar/` exists (unused by UI)                                                    |
| Q-17 | Mobile registration exact field set                                       | frontend-audit §11.13                     | needs deeper evidence  | 13-field state; itemization pending                                                                  |
| Q-18 | `estado_pedido.activo` (id 7) intent ("apartado"?)                        | database-audit §9.2                       | needs maintainer input | Seeded, unused                                                                                       |
| Q-19 | Does the deployed backend really reject farmer product writes?            | this audit (F-17)                         | needs deeper evidence  | Static evidence says Admin-only; runtime unverified                                                  |
| Q-20 | `persona.estado` / `logs.estado` / `mensajes_documentos.estado` consumers | database-audit §9.4                       | needs maintainer input | No API flips them                                                                                    |
| Q-21 | `familia_usuario` duplicates in live data; DB-level enforcement           | database-audit §9.5                       | needs deeper evidence  | No live DB in repo                                                                                   |
| Q-22 | Timezone policy for date columns / corte day boundary                     | database-audit §9.6, backend-audit §10.14 | needs maintainer input | es-ar TZ vs Nayarit geography (F-25)                                                                 |
| Q-23 | Liquidación payouts vs order payments modeling                            | database-audit §9.7                       | needs maintainer input | Distinction is only `fk_pedido IS NULL`                                                              |
| Q-24 | `login-api` doc drift / earlier contract in old clients                   | database-audit §9.8, backend-audit §10.13 | needs maintainer input | Endpoint does not exist                                                                              |
| Q-25 | Publication week range 1–52 vs ISO 53 years                               | database-audit §9.9                       | needs maintainer input | CHECK would reject manual week-53                                                                    |
| Q-26 | Indexes for hot filter/sort paths                                         | database-audit §9.10                      | needs deeper evidence  | Volumes unknown                                                                                      |
| Q-27 | Live data quality (orphans, `eliminar_pendiente` backlog, negative stock) | database-audit §9.1                       | needs deeper evidence  | No live DB/dump in repo                                                                              |
| Q-28 | Notifications: build or drop?                                             | frontend-audit §11.9                      | needs maintainer input | Stub only (F-19)                                                                                     |
| Q-29 | Admin product/category/unit CRUD: implement or drop?                      | frontend-audit §11.10                     | needs maintainer input | Mocked UI, real backend routes (F-16)                                                                |
| Q-30 | Buyer catalog category filter: build `id_categoria` support?              | frontend-audit §11.11                     | needs maintainer input | UI present, applied on neither app                                                                   |
| Q-31 | CSP hardening / production img-src & connect-src posture                  | frontend-audit §11.14                     | needs maintainer input | —                                                                                                    |
| Q-32 | Replicate or simplify web's per-request retry window                      | frontend-audit §11.15                     | needs maintainer input | —                                                                                                    |
| Q-33 | Production env values / API base URLs                                     | frontend-audit §11.16                     | needs maintainer input | Names only in repo                                                                                   |

(The register numbers run to Q-33; the four resolved rows are Q-01–Q-04, leaving 29 open
rows split across the two "needs" tags.)

## 6. Offline-First considerations

> **Disclaimer — Analysis only.** This section classifies evidenced usage patterns into
> offline-first needs. It does **not** design sync, does not propose implementation, and
> does not change the data model. Every cell below is derived from the audits' usage
> evidence (functional-map §2–§3); nothing is aspirational.

### Method

Classification was derived from how each entity is actually used today: read-heavy
catalogs fetched at login/form time; transactional money/stock writes guarded by locks
and credit checks; a polling chat; image binaries held as Drive URLs; append-only
histories; and admin-only aggregates. Where the legacy system itself is ambiguous
(e.g., recolección uniqueness), the classification inherits the ambiguity rather than
resolving it.

### Per-entity classification (Analysis)

Legend: reads/writes describe evidenced usage intensity (high/med/low/none);
Offline read / write / bidirectional sync are **need** judgments (Y = needed, N = not
needed, ? = genuinely ambiguous from evidence); "conflict-resolution consideration" is
what the evidence says would collide, not a chosen strategy.

| Entity                                                   | Typical reads                                    | Typical writes                                               | Local persistence need                    | Offline read      | Offline write                                                                              | Bidirectional sync                                                             | Versioning need                                         | Conflict-resolution consideration                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `municipio`, `localidad`                                 | high (registration, forms, pickers)              | low (admin CRUD, mobile only)                                | cache                                     | Y                 | N                                                                                          | N                                                                              | low                                                     | server-authoritative; trash/restore lifecycle exists                                                                                              |
| `categoria_producto`, `unidad`                           | high (forms, filters, wizard)                    | low (admin CRUD, mobile only)                                | cache                                     | Y                 | N                                                                                          | N                                                                              | low                                                     | server-authoritative                                                                                                                              |
| `producto`                                               | med (wizard picker, farmer list)                 | med in UI but **role-mismatched** (F-17); server: Admin-only | cache                                     | Y                 | ? (who may write is unresolved, Q-19)                                                      | N                                                                              | low                                                     | ownership rules must be settled first                                                                                                             |
| `producto_imagen` (Drive refs)                           | med (URL rendering)                              | med (uploads)                                                | none (binary references, not local-first) | Y (URLs)          | N (uploads need connectivity)                                                              | N                                                                              | low (principal/orden flags)                             | delete-failure semantics differ per legacy path (F-10)                                                                                            |
| `publicacion_semanal`, `producto_semanal`                | high (buyer catalog `current`; farmer dashboard) | med (farmer, Monday-gated)                                   | cache for buyer catalog                   | Y                 | ? (Monday window + per-item validation make offline publishing risky)                      | N                                                                              | med (estado lifecycle borrador→publicado→cerrado)       | publish validation is server-side; offline drafts would still need server validation                                                              |
| `pedido_cabecera`, `detalle_pedido`                      | med (buyer history/detail; seller panel)         | high (checkout; seller transitions)                          | cart is already local (zustand persist)   | Y                 | Y-value but money+stock (see note)                                                         | N (legacy had none)                                                            | med (estado machine + historial)                        | stock decrement, credit limit across family, and server-side validation are the collision surface; legacy idempotency was client-only (F-13/F-14) |
| `pago`                                                   | med (recibos)                                    | med (seller, one per pedido)                                 | low                                       | Y                 | N (reconcile-first pattern already assumes connectivity)                                   | N                                                                              | low (immutable after creation)                          | monto==total invariant is server-authoritative (F-05); folio generation is server-side                                                            |
| `recoleccion` (+ historial)                              | med (seller schedule)                            | med (create/transition/cancel)                               | low                                       | Y                 | ? (one-active-slot uniqueness per agricultor+fecha makes offline creation collision-prone) | N                                                                              | med (state machine + late-date exceptions)              | slot uniqueness is DB-backed (R1); offline creation needs server adjudication                                                                     |
| `corte`                                                  | low (seller daily)                               | low (one per vendedor+fecha)                                 | low                                       | Y (teorico)       | ? (teorico depends on server cash pagos)                                                   | N                                                                              | low (creation-time snapshots)                           | teorico/diferencia snapshots depend on server data at creation time                                                                               |
| `liquidacion`, `liquidacion_venta`                       | med (admin)                                      | none from UI (`/calcular/` unused; marcar-pagada only)       | cache                                     | Y (admin)         | N                                                                                          | N                                                                              | low (immutable snapshots)                               | anti-duplicate + idempotent payment are server-owned (L7/L8)                                                                                      |
| `merma`, `decision_merma`                                | low (resumen)                                    | none from UI (writes backend-only)                           | cache                                     | Y (admin resumen) | N (evidenced)                                                                              | N                                                                              | low                                                     | stock decrement flow exists but is unproductized (F-27)                                                                                           |
| `familia`, `familia_usuario`                             | low (admin)                                      | low (admin)                                                  | cache                                     | Y                 | N                                                                                          | N                                                                              | low (membership estado flags)                           | one-active-family rule is serializer-only (F-09)                                                                                                  |
| `conversacion`, `integrantes`, `mensaje`, `documento`    | high (polling 5–60 s)                            | high (messages, reads, edits)                                | today: none beyond memory cache           | Y-value           | ? (high write rate + read receipts + 15-min edit/delete windows)                           | eventual-sync candidate (chat is the only high-frequency bidirectional stream) | med (edit/delete windows, `leido` flags, unread counts) | ordering, read-state and unread counts are the collision surface; no legacy local persistence exists (F-22)                                       |
| `usuario`, `persona` (perfil)                            | med (self)                                       | low (profile edit, password)                                 | cache                                     | Y                 | N                                                                                          | N                                                                              | low                                                     | server-authoritative profile fields (email/role not editable)                                                                                     |
| `logs`, `historial_estado_*`                             | low (timelines)                                  | server-only (append)                                         | cache                                     | Y                 | N                                                                                          | N                                                                              | low (append-only)                                       | server-generated; client copies are views, not sources                                                                                            |
| `tipo_pago`, `decision_merma`, `estado_pedido` (lookups) | low-med (forms)                                  | none from UI                                                 | cache                                     | Y                 | N                                                                                          | N                                                                              | low                                                     | small seeded catalogs                                                                                                                             |

### Cross-cutting notes (Analysis)

- **Checkout idempotency learnings as input for future offline writes.** The legacy
  client-side machinery (in-flight records, fingerprint-stable keys, ambiguous markers,
  reconciliation by total+products+recency, cross-tab locks — frontend-audit §6) encodes
  real failure modes of mobile/web checkout: timeouts, tab closes, double submits, and
  envelope malformation. With the server ignoring the header (F-13), these patterns are
  requirements evidence for how offline order creation must behave, not code to carry
  over.
- **Financial invariants are server-authoritative candidates.** `monto == pedido.total`,
  one-pago-per-pedido, stock ≥ 0, credit limit across the family, and the folio sequence
  are all currently app-code + lock based (F-05/F-06/F-07). Under offline-first they
  must remain server decisions; the classification table marks every money/stock write
  accordingly.
- **Chat is the eventual-sync candidate.** It is the only high-frequency, bidirectional,
  multi-device stream; today it has zero local persistence and polling-only delivery
  (F-22). Its edit/delete windows, read flags, and unread counts are the state that any
  future sync would have to version.
- **Images are binary references, not local-first candidates.** Products hold Drive URLs
  (and legacy denormalized URL columns); the legacy system already treats uploads as
  online-only operations with a server-side cleanup state machine (F-10). Nothing in the
  evidence suggests local-first binaries.
- **Catalogs are cache-first candidates.** Municipios/localidades, categorías/unidades,
  lookup tables, and the weekly catalog are read-heavy and write-rare; the frontends
  already depend on them at form-render time, and the only offline behavior they get
  today is react-query's memory cache (F-23).

## 7. Recommended next evidence steps

Read-only verification tasks, phrased so each closes a specific open question before
design begins. None is an implementation task.

1. **Runtime-permission probe for F-17/Q-19** — against a development instance of
   `legacy/rassa_back`, execute `POST /productos/` (and `DELETE /productos/{id}/`) with
   an Agricultor JWT and record the actual status. Alternatively, ask the maintainer
   whether the deployed backend matches this checkout.
2. **Append-slash probe for I-01/Q-02** — `GET /api/pedidos/{id}/historial` (no trailing
   slash) against a dev instance; observe 301-vs-404 and whether axios follows it in both
   apps' production builds.
3. **Idempotency duplicate probe for F-13** — POST `/pedidos/` twice with the same
   `Idempotency-Key` on a dev instance; confirm duplicate creation (quantifies the
   client-only protection).
4. **Live-data snapshot review for Q-21/Q-27** — with maintainer-provided DB access: row
   counts, `eliminar_pendiente` backlog, duplicate `familia_usuario` rows, negative
   stock, `fk_vendedor` NULL distribution on pedidos, `estado_pedido.activo` usage,
   `recibo` row count.
5. **Itemize the mobile registration form (Q-17)** — read
   `useRegistrationForm`/`validateRegistrationForm` consumers in
   `legacy/rassa_front/src/` to pin the exact field list vs the web set.
6. **Envelope contract pinning** — extract expected envelopes from the 16 bruno
   collections (`legacy/rassa_back/bruno/`, ~144 requests) into a per-endpoint table to
   confirm the functional-map §4.3 map, especially liquidaciones error bodies and the
   pagos/cortes raw payloads.
7. **Maintainer interview list** — one session covering Q-05…Q-13, Q-16, Q-18, Q-20,
   Q-22…Q-25, Q-28…Q-33 (product intent: vendedor provisioning, Recibo, notifications,
   admin CRUD, timezone policy, admin CRUD contract, category filter, CSP, retry
   windows, env/deployment).
8. **Chat cadence measurement (Q-08/I-09)** — capture the polling behavior under mobile
   network conditions (battery/data cost) to decide whether realtime is a requirement or
   polling suffices in the new app.
