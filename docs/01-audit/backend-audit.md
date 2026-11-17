# Backend Audit — Legacy `rassa_back` (RassaJala)

Audit of the legacy Django backend at `legacy/rassa_back`, performed as the reference
input for building a new independent app (Bun + tRPC, Prisma, Supabase Postgres,
RxDB, offline-first PWA). The legacy code is **reference only**: nothing will be
reused or modified. Findings are separated into **Confirmed** (backed by verifiable
repo evidence with citations) and **Inference** (explicitly labeled, with the
evidence used). Gaps and open questions are collected in the final section and
never answered by invention.

## Quick path

1. Read [System overview](#1-system-overview) for the stack and layout.
2. Read [API surface](#3-api-surface) for the full route inventory (the contract the new app must honor or consciously change).
3. Read [Business rules](#5-business-rules) — the server-side invariants a reimplementation must respect.
4. Finish with [Gaps and open questions](#11-gaps-and-open-questions) before making design decisions.

---

## 1. System overview

**Status: Confirmed.**

### Stack (from `legacy/rassa_back/requirements.txt`)

| Component                                                                            | Version constraint | Purpose                            |
| ------------------------------------------------------------------------------------ | ------------------ | ---------------------------------- |
| Django                                                                               | `>=5.0,<5.1`       | Web framework (WSGI only)          |
| Django REST Framework                                                                | `>=3.15,<3.16`     | REST API layer                     |
| SimpleJWT (+ token_blacklist app)                                                    | `>=5.3,<5.4`       | JWT auth                           |
| django-cors-headers                                                                  | `>=4.3,<4.4`       | CORS                               |
| psycopg2-binary                                                                      | `>=2.9,<2.10`      | PostgreSQL driver                  |
| python-decouple                                                                      | `>=3.8`            | Env/`.env` config                  |
| gunicorn                                                                             | `>=22.0`           | Production WSGI server             |
| django-filter                                                                        | `>=24.0,<25.0`     | Filtersets                         |
| dj-database-url                                                                      | `>=2.1,<2.2`       | `DATABASE_URL` parsing             |
| google-api-python-client / google-auth / google-auth-oauthlib / google-auth-httplib2 | `>=2.0,<3.0`       | Google Drive file storage          |
| python-magic                                                                         | `>=0.4,<1.0`       | MIME sniffing for chat attachments |

Dev tooling: pytest/pytest-django/pytest-cov, ruff, pylint+pylint-django, pre-commit
(`legacy/rassa_back/requirements-dev.txt`, `legacy/rassa_back/pyproject.toml`).
Python pinned to 3.12 (`legacy/rassa_back/.python-version`). Django `makemigrations --check`
runs in CI (`legacy/rassa_back/.github/workflows/ci.yml`).

### Entry points

- `legacy/rassa_back/manage.py` — standard Django management entry (`DJANGO_SETTINGS_MODULE=rassa.settings`).
- `legacy/rassa_back/rassa/wsgi.py:12` — WSGI `application` for gunicorn. **No ASGI entrypoint exists** (no `asgi.py`, no channels, no async runtime).
- `legacy/rassa_back/Makefile` — dev tasks (`test`, `lint`, `ci`, `check`).
- `legacy/rassa_back/.github/workflows/ci.yml` — three jobs: ruff lint, pytest against a Postgres 16 service, Django system checks.

### Project layout

```
legacy/rassa_back/
├── manage.py, wsgi (rassa/wsgi.py), Makefile, pyproject.toml
├── rassa/                  # main app: models, settings, urls, views, serializers, permissions, services, signals, checks, filters, utils
│   ├── blueprints/         # feature modules: chat, cortes, familias, liquidaciones, pagos, pedido, producto_imagen, publicacion, recoleccion, waste
│   ├── migrations/         # 31 migration files (0001..0027 incl. squash + merges)
│   ├── permissions/        # role_permissions.py, ownership.py
│   ├── services/           # google_drive.py, drive_config.py
│   ├── management/commands/# seed_rassa_data, authorize_drive, cleanup_orphan_drive_files, reset_sequences, sanitizar_documentos
│   └── tests/              # 24 test files (~17,000 lines)
├── logs/                   # audit-log app (models.py is EMPTY; reuses rassa.Log)
├── bruno/                  # 16 HTTP collections (~144 request .bru files + collection.bru)
├── db/archive/rassa_jala.sql  # original 32-table SQL schema + seeders (superseded by migrations)
├── docs/                   # module architecture, runbooks, test users (Spanish)
└── scripts/                # test setup helpers only
```

### Installed apps (`legacy/rassa_back/rassa/settings.py:34-57`)

- Django: `admin`, `auth`, `contenttypes`, `sessions`, `messages`, `staticfiles`.
- Third-party: `rest_framework`, `rest_framework_simplejwt.token_blacklist`, `corsheaders`, `django_filters`.
- Local: `rassa.apps.RassaConfig`, `logs.apps.LogsConfig`.

`rassa.apps.RassaConfig.ready()` registers three signal/check modules
(`legacy/rassa_back/rassa/apps.py:29-33`): `rassa.signals` (pedido state history),
`rassa.blueprints.chat.signals` (family→chat name sync), `rassa.checks`
(PostgreSQL ≥ 15 deploy check).

### Settings module

Single settings file: `legacy/rassa_back/rassa/settings.py`. No settings split
(base/local/prod). Configuration via python-decouple reading a `.env`
(template at `legacy/rassa_back/.env.template`).

---

## 2. Authentication & authorization

**Status: Confirmed unless labeled otherwise.**

### 2.1 Identity model

- Authentication identity is the **default Django `auth.User`** (`legacy/rassa_back/rassa/settings.py:97-99`, docstring in `legacy/rassa_back/rassa/auth_serializers.py:1-8`). There is no custom `AUTH_USER_MODEL`.
- Business profile is `Usuario` (`legacy/rassa_back/rassa/models.py:185-228`): OneToOne to `auth.User` (`fk_user`, `SET_NULL`), OneToOne to `Persona` (CASCADE), `correo` (unique), `telefono`, FK `fk_rol` → `Rol` (PROTECT), soft-delete `estado` flag.
- Roles live in the `roles` table as data (not Django groups): seeded Admin, Vendedor, Agricultor, Cliente (`legacy/rassa_back/rassa/management/commands/seed_rassa_data.py:195-227`). Frontend-facing aliases map `buyer→Cliente`, `farmer→Agricultor`, `seller→Vendedor`, `admin→Admin` (`legacy/rassa_back/rassa/auth_serializers.py:24-36`).
- `Usuario.tiene_rol()` is the null-safe single source of truth for role checks (`legacy/rassa_back/rassa/models.py:215-228`).

### 2.2 SimpleJWT configuration (`legacy/rassa_back/rassa/settings.py:165-172`)

| Setting                  | Value                       |
| ------------------------ | --------------------------- |
| ACCESS_TOKEN_LIFETIME    | 2 hours                     |
| REFRESH_TOKEN_LIFETIME   | 7 days                      |
| ROTATE_REFRESH_TOKENS    | True                        |
| AUTH_HEADER_TYPES        | Bearer                      |
| USER_ID_FIELD            | id                          |
| BLACKLIST_AFTER_ROTATION | not set (defaults to False) |

The `token_blacklist` app is installed, so issued refresh tokens are tracked
(Outstanding/Blacklisted tables are Django-managed, not in this repo's migrations).

### 2.3 Auth endpoints

| Method    | Path                         | View                                                                     | Auth            | Notes                                                                                                                              |
| --------- | ---------------------------- | ------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| POST      | `/api/token/`                | `CustomTokenObtainPairView` (`legacy/rassa_back/rassa/urls.py:71-108`)   | AllowAny        | Email+password login; Spanish ambiguous errors; logs success and failure to `Log`; throttle scope `login`                          |
| POST      | `/api/token/refresh/`        | stock `TokenRefreshView` (`legacy/rassa_back/rassa/urls.py:114`)         | AllowAny        | Rotation on                                                                                                                        |
| POST      | `/api/auth/register/`        | `RegisterView` (`legacy/rassa_back/rassa/views.py:101-130`)              | AllowAny        | Public self-registration; role limited to buyer/seller (`legacy/rassa_back/rassa/auth_serializers.py:210`); returns access+refresh |
| POST      | `/api/auth/create-farmer/`   | `AdminCreateAgricultorView` (`legacy/rassa_back/rassa/views.py:133-176`) | Admin           | Farmer onboarding; token generation failure is non-fatal (ghost-user prevention)                                                   |
| GET/PATCH | `/api/auth/me/`              | `MeView` (`legacy/rassa_back/rassa/views.py:179-205`)                    | IsAuthenticated | Profile read/update (email and role not editable)                                                                                  |
| POST      | `/api/auth/change-password/` | `ChangePasswordView` (`legacy/rassa_back/rassa/views.py:208-238`)        | IsAuthenticated | Blacklists supplied refresh token; access tokens stay valid until expiry (documented in docstring)                                 |
| GET       | `/api/auth/search-users/`    | `SearchUsersView` (`legacy/rassa_back/rassa/views.py:779-827`)           | Admin           | Min 3 chars, max 10 results, excludes Admin role, excludes users already in an active family unless `include_assigned`             |
| GET       | `/api/auth/health/`          | `AuthHealthView` (`legacy/rassa_back/rassa/views.py:241-247`)            | AllowAny        | Health probe                                                                                                                       |

**There is no logout endpoint** and no dedicated token-blacklist endpoint; the only
blacklist trigger is the optional `refresh_token` field on change-password.

### 2.4 Password handling

- Hashing: Django default (PBKDF2) via `user.set_password()` (`legacy/rassa_back/rassa/auth_serializers.py:357-361`).
- Validators enabled: `MinimumLengthValidator`, `CommonPasswordValidator`, `NumericPasswordValidator` (`legacy/rassa_back/rassa/settings.py:100-104`). `UserAttributeSimilarityValidator` is NOT enabled.
- Register/change-password additionally enforce `min_length=6` field-level and `validate_password()` (`legacy/rassa_back/rassa/auth_serializers.py:208,228-233,339,348-355`).

### 2.5 Permission system (`legacy/rassa_back/rassa/permissions/`)

**RBAC implemented as DRF permission classes** (`legacy/rassa_back/rassa/permissions/role_permissions.py`):

- `HasRole(*roles)` — parameterized, callable-instance pattern so it can be used as `permission_classes = [HasRole("Admin")]` (`role_permissions.py:33-63`).
- `IsOwnerOrAdmin` — object-level, checks `usuario`/`fk_usuario`/`fk_cliente` attributes (`role_permissions.py:66-97`). Widely defined but **not used by the blueprints**; ownership of product images is handled by a dedicated helper instead (see below).
- `IsAdminOrReadOnly` — safe methods for authenticated users, writes for Admin (`role_permissions.py:100-115`).
- Backward-compatible aliases: `IsAdmin`, `IsAgricultor`, `IsVendedor`, `IsCliente`, `IsAdminOrAgricultor`, `IsAdminOrVendedor` (`role_permissions.py:118-124`).

**Role constants**: `ADMIN="Admin"`, `AGRICULTOR="Agricultor"`, `VENDEDOR="Vendedor"`, `CLIENTE="Cliente"` (`role_permissions.py:26-30`).

**Per-role access summary (Confirmed, from `get_permissions`/`get_queryset` per module):**

| Role       | Access highlights                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin      | Everything; full user management (`/api/admin/usuarios/*`); liquidaciones; merma resumen; logs; catalog writes; familia management                                                              |
| Vendedor   | Pedidos (list/retrieve/transition, assigned to them), pagos (create for their pedidos), mermas (their pedidos), cortes (their own), recolecciones (write), chat                                 |
| Agricultor | Own publicaciones + weekly products (Monday-only), own recolecciones (read-only), product image management for products they have published                                                     |
| Cliente    | Create pedidos, view own pedidos/payments, chat; no estado transitions, no recolección visibility (empty queryset by design, `legacy/rassa_back/rassa/blueprints/recoleccion/views.py:234-242`) |

**Ownership special case** (`legacy/rassa_back/rassa/permissions/ownership.py:12-43`):
an Agricultor may only manage images of products for which they have at least one
`PublicacionSemanal`; Admin bypasses. Enforced in both product-image modules.

**Query-set-level authorization** (in addition to permission classes): Vendedor sees
only their pedidos/payments/cortes/mermas; Cliente sees only their pedidos/payments;
recolecciones restrict Agricultor to their own rows with an explicit ownership
validation error (`legacy/rassa_back/rassa/blueprints/recoleccion/views.py:222-258`).

**Inference**: the `logs` app's `IsAdmin` permission (`legacy/rassa_back/logs/views.py:13-16`)
queries `Usuario` by `fk_user` per request — a per-request DB hit instead of the shared
`HasRole` helper. Evidence: different implementation style for the same RBAC rule; no
functional difference is documented.

### 2.6 Audit logging (cross-cutting)

- Every state-changing request (POST/PUT/PATCH/DELETE) is logged by
  `ActivityLogMiddleware` (`legacy/rassa_back/logs/middleware.py`) into the `logs`
  table, unless the path is in `EXCLUDED_PATHS` (`/admin/`, `/api/token/`,
  `/api/token/refresh/` — `legacy/rassa_back/rassa/settings.py:158-162`) or the view
  already logged via the `request._audit_logged` flag set by `_log()`
  (`legacy/rassa_back/rassa/views.py:29-40`).
- Login attempts (success and failure) are logged explicitly in
  `CustomTokenObtainPairView` (`legacy/rassa_back/rassa/urls.py:77-106`).
- Client IP resolution trusts `X-Forwarded-For` only when the direct peer is in
  `TRUSTED_PROXIES` (`legacy/rassa_back/logs/utils.py:4-17`).

---

## 3. API surface

**Status: Confirmed.** Route inventory from `legacy/rassa_back/rassa/urls.py` plus the
10 blueprint `urls.py` files. Bruno collections are listed per resource as corroboration.
Default DRF router suffixes apply (`/` trailing). Pagination default: `PageNumberPagination`,
page size 20 (`legacy/rassa_back/rassa/settings.py:113-114`). Response bodies are wrapped
in an `{ok, data, message}` envelope by `_ok()`/`OkResponseMixin`
(`legacy/rassa_back/rassa/views.py:43-98`) — **except** where noted (pagos, cortes,
producto imagen endpoints return raw serializer payloads; `tipos_pago` returns a plain
array by frontend contract, `legacy/rassa_back/rassa/blueprints/pagos/views.py:208-213`).

### 3.1 Auth & users

Routes in `legacy/rassa_back/rassa/urls.py:111-174`; views in `views.py`, `admin_views.py`.
Bruno: `legacy/rassa_back/bruno/auth/` (9 files: login, refresh_token, register, get_me,
patch_me, change_password, create_farmer, search_users, search_users_include_assigned),
`legacy/rassa_back/bruno/usuarios_admin/` (8 files: listar, detalle, editar, filtrar_rol,
filtrar_estado, toggle_estado, buscar).

| Method(s)  | Path                                      | View                                                                           | Auth / Permission | CRUD coverage                                   |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------- |
| POST       | `/api/token/`                             | CustomTokenObtainPairView                                                      | AllowAny          | login                                           |
| POST       | `/api/token/refresh/`                     | TokenRefreshView                                                               | AllowAny          | refresh                                         |
| POST       | `/api/auth/register/`                     | RegisterView                                                                   | AllowAny          | create (buyer/seller only)                      |
| POST       | `/api/auth/create-farmer/`                | AdminCreateAgricultorView                                                      | Admin             | create (farmer)                                 |
| GET, PATCH | `/api/auth/me/`                           | MeView                                                                         | IsAuthenticated   | retrieve / partial update                       |
| POST       | `/api/auth/change-password/`              | ChangePasswordView                                                             | IsAuthenticated   | change password                                 |
| GET        | `/api/auth/search-users/`                 | SearchUsersView                                                                | Admin             | search                                          |
| GET        | `/api/auth/health/`                       | AuthHealthView                                                                 | AllowAny          | health                                          |
| GET        | `/api/admin/usuarios/`                    | `AdminUsuarioViewSet.list` (`legacy/rassa_back/rassa/admin_views.py:124-184`)  | Admin             | list (search/rol/estado filters, paginated)     |
| GET        | `/api/admin/usuarios/{id}/`               | `AdminUsuarioViewSet.retrieve` (`admin_views.py:186-203`)                      | Admin             | retrieve                                        |
| PATCH      | `/api/admin/usuarios/{id}/`               | `AdminUsuarioViewSet.partial_update` (`admin_views.py:205-262`)                | Admin             | partial update (persona fields, telefono, role) |
| PATCH      | `/api/admin/usuarios/{id}/toggle-estado/` | `AdminUsuarioViewSet.toggle_estado` (`admin_views.py:264-319`)                 | Admin             | activate/deactivate                             |
| GET        | `/api/logs/`, `/api/logs/{id}/`           | `ActivityLogViewSet` (`legacy/rassa_back/logs/urls.py`, `logs/views.py:19-36`) | Admin             | list/retrieve of audit log                      |

No user **delete** endpoint exists (only `estado` toggle); no user **create-seller** endpoint (public register covers seller).

### 3.2 Municipios & localidades (geographic catalogs)

Views in `legacy/rassa_back/rassa/views.py:465-773`. Bruno: `legacy/rassa_back/bruno/catalogos/` (17 files).

| Method(s)               | Path                                                        | Permission                           | CRUD coverage                                                  |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| GET, POST               | `/api/municipios/`                                          | public read (AllowAny) / Admin write | list, create                                                   |
| GET                     | `/api/municipios/trash/`                                    | public read                          | trash list (soft-deleted)                                      |
| GET, PUT, PATCH, DELETE | `/api/municipios/{id}/`                                     | IsAuthenticated read / Admin write   | retrieve, update, **soft delete**                              |
| POST                    | `/api/municipios/{id}/restore/`                             | Admin                                | restore                                                        |
| PATCH                   | `/api/municipios/{id}/estado/`                              | Admin                                | activate/deactivate                                            |
| POST                    | `/api/municipios/{id}/permanent/`                           | Admin                                | hard delete (blocked if localidades exist, `views.py:746-766`) |
| GET, POST               | `/api/municipios/{id}/localidades/` and `/api/localidades/` | public read / Admin write            | list (by municipio), create                                    |
| GET                     | `/api/localidades/trash/`                                   | public read                          | trash list                                                     |
| GET, PUT, PATCH, DELETE | `/api/localidades/{id}/`                                    | IsAuthenticated / Admin              | retrieve, update, soft delete                                  |
| POST                    | `/api/localidades/{id}/restore/`                            | Admin                                | restore                                                        |
| PATCH                   | `/api/localidades/{id}/estado/`                             | Admin                                | activate/deactivate                                            |
| POST                    | `/api/localidades/{id}/permanent/`                          | Admin                                | hard delete                                                    |

### 3.3 Categorías & unidades (product catalogs)

`CategoriaProductoViewSet` / `UnidadViewSet` — both extend `CatalogViewSet`
(`legacy/rassa_back/rassa/views.py:254-351`) registered via router
(`legacy/rassa_back/rassa/urls.py:66-67`). Permission: `IsAdminOrReadOnly`.
Bruno: `legacy/rassa_back/bruno/categorias/` (8 files), `legacy/rassa_back/bruno/unidades/` (8 files).

| Method(s)               | Path                                                               | CRUD coverage                                             |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| GET, POST               | `/api/categorias/`, `/api/unidades/`                               | list, create                                              |
| GET                     | `/api/categorias/trash/`, `/api/unidades/trash/`                   | trash list                                                |
| GET, PUT, PATCH, DELETE | `/api/categorias/{id}/`, `/api/unidades/{id}/`                     | retrieve, update, soft delete                             |
| POST                    | `/api/categorias/{id}/restore/`, `/api/unidades/{id}/restore/`     | restore                                                   |
| POST                    | `/api/categorias/{id}/permanent/`, `/api/unidades/{id}/permanent/` | hard delete (409 on `ProtectedError`, `views.py:328-341`) |

### 3.4 Productos (catalog CRUD + images)

Views: `legacy/rassa_back/rassa/productos_views.py`. Bruno: `legacy/rassa_back/bruno/productos/` (13 files).

| Method(s)               | Path                                                     | Permission                                        | CRUD coverage                                                               |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| GET, POST               | `/api/productos/`                                        | Admin write / authenticated read                  | list (django-filter filterset, search, ordering), create                    |
| GET, PUT, PATCH, DELETE | `/api/productos/{id}/`                                   | Admin write / authenticated read                  | retrieve, update, **soft delete** (no trash/restore endpoints for producto) |
| POST                    | `/api/productos/{id}/imagen/`                            | Admin (via `IsAdminOrReadOnly`) + ownership check | upload image (multipart `imagen` or JSON `imagen_base64`) → Google Drive    |
| DELETE, PATCH           | `/api/productos/{id}/imagen/{id_imagen}/`                | IsAuthenticated + ownership check                 | delete image (Drive delete + principal reassignment), patch `es_principal`  |
| GET, POST               | `/api/productos/{id}/imagenes/`                          | GET any authenticated; POST Admin/Agricultor      | list, upload (Drive)                                                        |
| DELETE, PATCH           | `/api/productos/{id}/imagenes/{image_id}/`               | Admin/Agricultor                                  | delete, partial update (`url`, `orden` only)                                |
| PATCH                   | `/api/productos/{id}/imagenes/{image_id}/set-principal/` | Admin/Agricultor                                  | set principal (atomic, row-locked)                                          |

Two parallel image pipelines exist (see §10 gotchas).

### 3.5 Publicaciones semanales (farmer weekly offers)

Views: `legacy/rassa_back/rassa/blueprints/publicacion/views.py`, routes
`legacy/rassa_back/rassa/blueprints/publicacion/urls.py`. Permission: Agricultor
(except `current`, AllowAny). Bruno: `legacy/rassa_back/bruno/publicaciones/` (14 files).

| Method(s)     | Path                                                  | CRUD coverage                                                 |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| GET           | `/api/publicaciones/current/`                         | public list of this week's `publicado` publications (max 100) |
| GET, POST     | `/api/publicaciones/`                                 | list (own), create (next Monday, ISO week)                    |
| GET, DELETE   | `/api/publicaciones/{id}/`                            | retrieve, destroy (borrador→cancelado)                        |
| POST          | `/api/publicaciones/{id}/publish/`                    | borrador→publicado with per-item validation                   |
| POST          | `/api/publicaciones/{id}/close/`                      | publicado→cerrado                                             |
| GET, POST     | `/api/publicaciones/{pub_id}/productos/`              | list (activos), create                                        |
| PATCH, DELETE | `/api/publicaciones/{pub_id}/productos/{id}/`         | partial update, destroy (activo→inactivo)                     |
| POST          | `/api/publicaciones/{pub_id}/productos/{id}/restore/` | inactivo→activo                                               |

### 3.6 Pedidos

Views: `legacy/rassa_back/rassa/blueprints/pedido/views.py`, routes
`legacy/rassa_back/rassa/blueprints/pedido/urls.py`. Bruno: `legacy/rassa_back/bruno/pedidos/`
(6 files: listar, listar_filtrados, detalle, crear_pedido, cambiar_estado, historial).

| Method(s) | Path                           | Permission                                                       | CRUD coverage                                        |
| --------- | ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------- |
| GET       | `/api/pedidos/`                | Vendedor/Admin/Cliente (role-filtered, `pedido/views.py:79-102`) | list + `?estado=` filter                             |
| POST      | `/api/pedidos/`                | **Cliente only** (`pedido/views.py:74-77`)                       | create (cart of `items`)                             |
| GET       | `/api/pedidos/{id}/`           | role-filtered                                                    | retrieve                                             |
| PATCH     | `/api/pedidos/{id}/status/`    | Vendedor/Admin (client rejected)                                 | state transition (linear `SECUENCIA` or `cancelado`) |
| GET       | `/api/pedidos/{id}/historial/` | authenticated (Vendedor limited to own)                          | state history                                        |

No update/delete of pedidos; no direct vendedor-assignment endpoint (assignment is not
in the create flow — **Inference**: assignment presumably happens outside this API or is
left unset; evidence: `PedidoCreateSerializer` has no vendedor field and
`PedidoCabecera.fk_vendedor` is nullable).

### 3.7 Pagos

Views: `legacy/rassa_back/rassa/blueprints/pagos/views.py`. Bruno: `legacy/rassa_back/bruno/pagos/` (4 files).

| Method(s) | Path               | Permission                         | CRUD coverage                                                                          |
| --------- | ------------------ | ---------------------------------- | -------------------------------------------------------------------------------------- |
| GET       | `/api/pagos/`      | Vendedor (own)/Cliente (own)/Admin | list + `?pedido=` filter                                                               |
| POST      | `/api/pagos/`      | Vendedor/Admin                     | create (only when pedido is `listo_para_retirar`; auto-advances pedido to `entregado`) |
| GET       | `/api/pagos/{id}/` | role-filtered                      | retrieve                                                                               |
| GET       | `/api/tipos-pago/` | IsAuthenticated                    | catalog list (plain array response)                                                    |

No update/delete of pagos.

### 3.8 Liquidaciones (weekly farmer settlements)

Views: `legacy/rassa_back/rassa/blueprints/liquidaciones/views.py`. **Admin only**
(`liquidaciones/views.py:268`). Bruno: `legacy/rassa_back/bruno/liquidaciones/` (4 files).

| Method(s) | Path                                     | CRUD coverage                                                           |
| --------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| GET       | `/api/liquidaciones/`                    | list (filters: `agricultor`, `estado`, `periodo_inicio`, `periodo_fin`) |
| GET       | `/api/liquidaciones/{id}/`               | retrieve (with ventas snapshot + pago)                                  |
| POST      | `/api/liquidaciones/calcular/`           | calculate for `agricultor`+`semana`+`anio`                              |
| POST      | `/api/liquidaciones/{id}/marcar-pagada/` | idempotent payment marking (creates `Pago` with `fk_pedido=NULL`)       |

### 3.9 Cortes (cash drawer)

Views: `legacy/rassa_back/rassa/blueprints/cortes/views.py`. Permission: Admin/Vendedor
(Vendedor sees own). Bruno: `legacy/rassa_back/bruno/cortes/` (4 files).

| Method(s) | Path                   | CRUD coverage                                                       |
| --------- | ---------------------- | ------------------------------------------------------------------- |
| GET       | `/api/cortes/`         | list (Vendedor: own)                                                |
| GET       | `/api/cortes/{id}/`    | retrieve                                                            |
| POST      | `/api/cortes/`         | create (monto_teorico computed server-side; one per vendedor+fecha) |
| GET       | `/api/cortes/teorico/` | theoretical cash for a date (60 s cache)                            |

No update/delete of cortes.

### 3.10 Familias (farmer family groups)

Views: `legacy/rassa_back/rassa/blueprints/familias/views.py`. **Admin only**. Bruno:
`legacy/rassa_back/bruno/familias/` (14 files: crear, listar, detalle, actualizar,
actualizar-parcial, eliminar, eliminar-permanente, grupos-listar-trash, grupos-restaurar,
asignar_jefe, agregar_miembro, miembros-listar, miembros-detalle, miembros-eliminar).

| Method(s)               | Path                                      | CRUD coverage                                                                                            |
| ----------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET, POST               | `/api/familias/grupos/`                   | list (activos), create                                                                                   |
| GET                     | `/api/familias/grupos/trash/`             | trash list                                                                                               |
| GET, PUT, PATCH, DELETE | `/api/familias/grupos/{id}/`              | retrieve, update, **soft delete** (also deactivates members + family chat)                               |
| POST                    | `/api/familias/grupos/{id}/restore/`      | restore (requires new `fk_jefe_familia` in body)                                                         |
| POST                    | `/api/familias/grupos/{id}/permanent/`    | hard delete (deletes members first, archives chat)                                                       |
| POST                    | `/api/familias/grupos/{id}/asignar-jefe/` | assign chief (must be active member)                                                                     |
| GET, POST               | `/api/familias/miembros/`                 | list (filter `?fk_familia=`), create membership                                                          |
| GET, DELETE             | `/api/familias/miembros/{id}/`            | retrieve, destroy (soft delete; PUT/PATCH are disabled via `http_method_names`, `familias/views.py:196`) |

### 3.11 Chat

Views: `legacy/rassa_back/rassa/blueprints/chat/views.py`, routes
`legacy/rassa_back/rassa/blueprints/chat/urls.py`. All IsAuthenticated; membership
checks per conversation; chat-admin (Integrante.rol="admin") required for group
management. Bruno: `legacy/rassa_back/bruno/chat/` (17 files).

| Method(s) | Path                                                         | CRUD coverage                                                                       |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| POST      | `/api/chat/conversaciones/crear-privada/`                    | get-or-create private conversation (200 if exists, 201 if created)                  |
| POST      | `/api/chat/conversaciones/crear-grupal/`                     | create group (creator = chat admin; manual `fk_familia` forbidden)                  |
| PATCH     | `/api/chat/conversaciones/{id}/renombrar/`                   | rename (chat admin; family chats require `nombre_override`)                         |
| PATCH     | `/api/chat/conversaciones/{id}/override-nombre/`             | toggle family-name override (chat admin)                                            |
| POST      | `/api/chat/conversaciones/familia/{familia_id}/sincronizar/` | **Admin**: resync family conversation                                               |
| POST      | `/api/chat/conversaciones/{id}/agregar-integrante/`          | add/reactivate member (chat admin)                                                  |
| DELETE    | `/api/chat/conversaciones/{id}/integrantes/{usuario_id}/`    | remove member (soft)                                                                |
| GET       | `/api/chat/conversaciones/{id}/integrantes/`                 | list members                                                                        |
| GET       | `/api/chat/usuarios/conversaciones/`                         | list own conversations with last message + unread count                             |
| GET       | `/api/chat/conversaciones/{id}/`                             | conversation detail                                                                 |
| GET       | `/api/chat/conversaciones/{id}/mensajes/`                    | list messages (paginated)                                                           |
| POST      | `/api/chat/mensajes/enviar/`                                 | send text message                                                                   |
| POST      | `/api/chat/mensajes/enviar-con-documento/`                   | send message + file (multipart; Drive-less local storage under `media/documentos/`) |
| PATCH     | `/api/chat/mensajes/{id}/editar/`                            | edit own message (15-minute window)                                                 |
| PATCH     | `/api/chat/mensajes/{id}/inactivar/`                         | soft-delete own message (15-minute window)                                          |
| PATCH     | `/api/chat/conversaciones/{id}/leer/`                        | mark all incoming messages read                                                     |
| GET       | `/api/chat/usuarios/buscar/`                                 | user search (min 3 chars, max 10)                                                   |

### 3.12 Mermas (waste/losses)

Views: `legacy/rassa_back/rassa/blueprints/waste/views.py`. Bruno: `legacy/rassa_back/bruno/mermas/` (11 files).

| Method(s)          | Path                          | Permission     | CRUD coverage                                                                                                   |
| ------------------ | ----------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| GET, POST          | `/api/decisiones-merma/`      | Admin          | list (`?incluir_inactivos=`), create                                                                            |
| GET, PATCH, DELETE | `/api/decisiones-merma/{id}/` | Admin          | retrieve, update, **soft delete**                                                                               |
| GET, POST          | `/api/mermas/`                | Admin/Vendedor | list (Vendedor: own pedidos; filters `?incluir_inactivos=`, `?fk_pedido=`), create (stock decrement under lock) |
| GET                | `/api/mermas/{id}/`           | Admin/Vendedor | retrieve                                                                                                        |
| GET                | `/api/mermas/resumen/`        | Admin          | aggregated report (group by mes/semana; top product)                                                            |

No update/delete of mermas (register-only).

### 3.13 Recolecciones (pickup scheduling)

ViewSet `RecoleccionViewSet` (`legacy/rassa_back/rassa/blueprints/recoleccion/views.py:136-496`),
router `legacy/rassa_back/rassa/blueprints/recoleccion/urls.py`. Reads: any authenticated
(role-scoped); writes: Admin/Vendedor. Bruno: `legacy/rassa_back/bruno/recolecciones/` (7 files).

| Method(s) | Path                                | CRUD coverage                                                                    |
| --------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| GET       | `/api/recolecciones/`               | list (filters: `estado`, `fk_agricultor`, `fecha`, `fecha_desde`, `fecha_hasta`) |
| POST      | `/api/recolecciones/`               | create (`estado` forbidden in body; agricultor locked & validated)               |
| GET       | `/api/recolecciones/{id}/`          | retrieve                                                                         |
| PATCH     | `/api/recolecciones/{id}/`          | partial update (only while `pendiente`)                                          |
| POST      | `/api/recolecciones/{id}/estado/`   | strict state machine (400 if already in that state)                              |
| POST      | `/api/recolecciones/{id}/cancelar/` | idempotent cancel (200 if already cancelled)                                     |
| GET       | `/api/recolecciones/agricultores/`  | farmer selector for Admin/Vendedor                                               |

No delete of recolecciones (cancel only). `PUT` and `DELETE` are disabled
(`recoleccion/views.py:174`).

### 3.14 Bruno cross-check

All 16 bruno folders (`legacy/rassa_back/bruno/bruno.json`) map to URL-configured
resources; ~144 request files plus `collection.bru`. Every route family in §3.1–3.13
has at least one bruno request file, with three exceptions noted in
[Gaps](#11-gaps-and-open-questions): `/api/logs/`, `/api/auth/health/`, and the
producto `DELETE/PATCH /api/productos/{id}/imagen/{id_imagen}/` legacy paths appear in
URL config without dedicated bruno files (the newer `/imagenes/` paths do have them:
`legacy/rassa_back/bruno/producto_imagenes/` — 4 files).

---

## 4. Serializers & validation

**Status: Confirmed.** Per-resource accepted fields and validators.

### Auth & users (`legacy/rassa_back/rassa/auth_serializers.py`)

| Serializer                                                                                     | Accepted (write) fields                                                                                                                              | Validators                                                                                                                                                                                                    | Notes                                                                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `RegisterSerializer` (`:204-246`)                                                              | email, password, telefono, role (buyer/seller), nombre, apellido_paterno, apellido_materno?, fecha_nacimiento, sexo (M/F/O), domicilio, fk_localidad | email uniqueness across `auth.User.username/email` AND `Usuario.correo`; `validate_password`; localidad must exist + be active with active municipio; IntegrityError inspection maps duplicate email/telefono | Creates User+Persona+Usuario in one transaction (`_create_usuario_db`, `:61-111`) |
| `AdminCreateAgricultorSerializer` (`:249-285`)                                                 | same minus `role` (always Agricultor)                                                                                                                | reuses RegisterSerializer bound validators                                                                                                                                                                    |                                                                                   |
| `ProfileUpdateSerializer` (`:288-328`)                                                         | telefono, nombre, apellido_paterno, apellido_materno?, fecha_nacimiento, sexo, domicilio, fk_localidad (all optional)                                | localidad validator                                                                                                                                                                                           | email/role not editable                                                           |
| `ChangePasswordSerializer` (`:331-361`)                                                        | old_password, new_password, refresh_token?                                                                                                           | old password check; `validate_password`; new ≠ old                                                                                                                                                            |                                                                                   |
| `CustomTokenObtainPairSerializer` (`:119-143`)                                                 | email, password                                                                                                                                      | ambiguous error message (anti-enumeration); checks `user.is_active`                                                                                                                                           | sets `serializer.user` for the view                                               |
| `AdminUserUpdateSerializer` (`legacy/rassa_back/rassa/admin_serializers.py`, single-line file) | telefono, nombre, apellido_paterno, apellido_materno?, fecha_nacimiento, sexo, domicilio, fk_localidad, role                                         | role must map to an existing Rol; localidad must exist                                                                                                                                                        | atomic update of Usuario + Persona                                                |
| `AdminUserSerializer`                                                                          | read-only projection incl. `role` alias and localidad name                                                                                           | —                                                                                                                                                                                                             |                                                                                   |

### Catalogs (`legacy/rassa_back/rassa/catalogos_serializers.py`)

- `MunicipioSerializer` / `LocalidadSerializer`: fields `nombre` (+ `municipio_id` for localidad); shared `_validate_nombre` (non-empty, max_length from model, trimmed) (`:12-24`); `estado` read-only.
- `CategoriaProductoSerializer`: nombre, descripcion.
- `UnidadSerializer`: nombre, abreviatura required; **legacy `tipo` column kept in sync with `nombre`** (`:78-91`).
- `CambiarEstadoSerializer`: boolean `estado` only (`:59-68`).

### Productos (`legacy/rassa_back/rassa/productos_serializers.py`)

- `ProductoDetailSerializer` (create/update): nombre_producto (strip, non-empty), descripcion, precio (≥ 0), stock (≥ 0), es_perecedero, `fk_categoria` (must be active), `fk_unidad` optional; `imagen`/`estado` read-only (`:61-103`).
- `ProductoListSerializer`: lightweight list with nested categoria/unidad + `imagen_principal` method field (`:27-58`).
- `ProductoImagenSerializer` (productos_views flavor): read-only `id_imagen, url, es_principal` (`:20-24`).
- Blueprint flavor `ProductoImagenSerializer` (`legacy/rassa_back/rassa/blueprints/producto_imagen/serializers.py:8-23`): includes `fk_producto`, `orden`, `drive_file_id`, `creado_en`; `validate_url` requires **HTTPS only**.

### Publicaciones (`legacy/rassa_back/rassa/blueprints/publicacion/serializers.py`)

- `ProductoSemanalSerializer` (create/update): fk_producto, fk_unidad, stock (> 0), precio (> 0), foto (URLValidator); estado/fk_publicacion/creado_en read-only.
- `PublicacionSerializer`: all read-only except nothing (create path constructs the model directly in the view).
- `PublicacionCurrentSerializer`: nested agricultor resume + activo products (public shape).

### Pedidos (`legacy/rassa_back/rassa/blueprints/pedido/serializers.py`)

- `PedidoCreateSerializer`: `items` list (min 1) of `{id_producto_semanal, cantidad ≥ 1}` (`:202-205`); duplicate-item detection happens in the view under lock (`pedido/views.py:346-351`).
- `ItemPedidoSerializer.validate_id_producto_semanal` (`:182-197`): existence, productosemanal `activo`, publication `publicado`, catalog product `estado=True`.
- `PedidoCambiarEstadoSerializer`: `nuevo_estado` choice among confirmado/en_preparacion/listo_para_retirar/entregado/cancelado (`:169-173`); transition rules in the view.
- Output serializers: `PedidoListSerializer`, `PedidoDetailSerializer`, `PedidoOutputSerializer`, `HistorialEstadoSerializer` (nested names instead of IDs).

### Pagos (`legacy/rassa_back/rassa/blueprints/pagos/serializers.py`)

- `PagoCreateSerializer`: pedido (int), tipo_pago (must exist), monto (> 0), referencia? — cross-validation: pedido exists, is `listo_para_retirar`, has no pago yet, and **monto must equal pedido.total within 0.001** (`:29-49`). State re-validated under row lock in the view (`pagos/views.py:121-131`).
- Output: `PagoOutputSerializer` (recibo-shaped: folio, tipo_pago_nombre, cliente, productos, total_pedido), `PagoListSerializer`.

### Liquidaciones (`legacy/rassa_back/rassa/blueprints/liquidaciones/serializers.py`)

- `CalcularLiquidacionSerializer`: agricultor (must exist, have role Agricultor, be active), semana (1–53), anio (2000–2100); ISO-week existence check via `date.fromisocalendar` (`:107-127`).
- `MarcarPagadaSerializer`: tipo_pago (must exist), referencia?.

### Cortes (`legacy/rassa_back/rassa/blueprints/cortes/serializers.py`)

- `CorteCreateSerializer`: monto_real (≥ 0), fecha (defaults to today). `monto_teorico`/`diferencia`/`estado` are server-computed.

### Familias (`legacy/rassa_back/rassa/blueprints/familias/serializers.py`)

- `FamiliaSerializer`: nombre_familia (≥ 3 chars), detalle_familia; `fk_jefe_familia` read-only (set via `asignar-jefe` or restore).
- `FamiliaMiembroSerializer`: fk_usuario, fk_familia, estado; validates both active and **exclusivity: a user may belong to only one active family** (`validate`, `:57-88`).

### Chat (`legacy/rassa_back/rassa/blueprints/chat/serializers.py`)

- `MensajeCreateSerializer`: fk_conversacion (member + active), contenido (min 1).
- `MensajeDocumentoCreateSerializer`: conversacion, tipo_documento (imagen/audio/video), archivo (≤ 20 MB; extension whitelist per type; **python-magic MIME sniff** when the library is importable — `:63-87`), contenido?
- `MensajeUpdateSerializer`: contenido; validates ownership + 15-minute window.

### Mermas (`legacy/rassa_back/rassa/blueprints/waste/serializers.py`)

- `DecisionMermaSerializer`: decision (unique across all rows, `UniqueValidator`).
- `MermaCreateSerializer`: fk_producto_semanal (int ≥ 1), fk_pedido (must exist and contain that producto_semanal — `validate`), cantidad (> 0), motivo, comentarios?, fk_decision (must be active).

### Recolecciones (`legacy/rassa_back/rassa/blueprints/recoleccion/serializers.py`)

- `RecoleccionSerializer`: fk_agricultor (exists/active/role Agricultor), fecha_recoleccion (not in the past on create; backdating allowed on PATCH by design), hora_inicio/hora_fin (both-or-none, fin > inicio), comentarios; `estado` read-only. Autogenerated UniqueTogetherValidator is intentionally disabled (`validators = []`, `:76-81`) — uniqueness is enforced by the DB partial constraint plus pre-checks.
- `RecoleccionCambiarEstadoSerializer`: strict transition table `TRANSICIONES_VALIDAS` (`:17-22`) with business exceptions (late completion; pendiente→recolectado when date passed; pendiente→en_ruta blocked when date passed).

### Nested writes

Almost none. The only multi-table write patterns are hand-rolled in views/services:
registration (User+Persona+Usuario), pedido create (Pedido+Detalles bulk), liquidación
calculation (Liquidación+LiquidacionVenta bulk), chat document send (Documento+Mensaje+
MensajeDocumento), familias (Familia+FamiliaUsuario+chat sync). **No DRF nested
serializers with `.create()` overrides are used.**

---

## 5. Business rules

**Status: Confirmed — every rule cites its implementing file and line.**

### Ordering & checkout (pedidos)

| #   | Rule                                                                                                                                                                                                                           | Evidence                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| B1  | Only Cliente can create pedidos                                                                                                                                                                                                | `legacy/rassa_back/rassa/blueprints/pedido/views.py:114-120`                           |
| B2  | Items validated twice: serializer pre-check + re-validation under `select_for_update` (existence, stock, estado activo, publication `publicado`, catalog product active)                                                       | `pedido/views.py:336-397`                                                              |
| B3  | Duplicate items rejected                                                                                                                                                                                                       | `pedido/views.py:346-351`                                                              |
| B4  | Stock rows locked in pk order to avoid deadlocks; stock decremented atomically                                                                                                                                                 | `pedido/views.py:353-360, 139-142`                                                     |
| B5  | IVA = 21 % of subtotal (`settings.IVA_RATE`); `total = subtotal + iva` recomputed on every save                                                                                                                                | `legacy/rassa_back/rassa/settings.py:246`, `legacy/rassa_back/rassa/models.py:442-444` |
| B6  | Credit limit: sum of **pending** pedidos of the client **and all active family members** + new total must not exceed `LimiteCliente.monto`; all under `select_for_update`                                                      | `pedido/views.py:442-491`                                                              |
| B7  | Linear state machine `pendiente→confirmado→en_preparacion→listo_para_retirar→entregado`; `cancelado` allowed only from `{pendiente, confirmado, en_preparacion, listo_para_retirar}`; terminal states `{entregado, cancelado}` | `pedido/views.py:50-55`, `pedido/serializers.py:8-9`                                   |
| B8  | Clients cannot change state; state change writes `HistorialEstadoPedido` with the actor                                                                                                                                        | `pedido/views.py:206-282`                                                              |
| B9  | Expired-pending-pedido check (`fecha_expiracion < now`) blocks transitions — but `fecha_expiracion` is never set by the create flow (seed data only)                                                                           | `pedido/serializers.py:21-32`, `PedidoCreateSerializer` (no such field)                |

### Payments (pagos)

| #   | Rule                                                                                         | Evidence                                                                  |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| P1  | Payment allowed only when pedido is `listo_para_retirar`; re-checked under row lock (TOCTOU) | `pagos/views.py:121-131`                                                  |
| P2  | Exactly one pago per pedido (DB constraint + pre-check); monto must equal pedido.total       | `pagos/serializers.py:40-49`, `legacy/rassa_back/rassa/models.py:505-510` |
| P3  | Successful payment auto-advances pedido to `entregado` with history entry                    | `pagos/views.py:149-159`                                                  |
| P4  | Folio generated as `REC-YYYYMMDD-###` under a `pg_advisory_xact_lock` (PostgreSQL)           | `legacy/rassa_back/rassa/models.py:515-530`                               |
| P5  | Vendedor can only pay their own pedidos                                                      | `pagos/views.py:114-119`                                                  |

### Cash reconciliation (cortes)

| #   | Rule                                                                                                                      | Evidence                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| C1  | `monto_teorico` = sum of **cash** (`fk_tipo__nombre__iexact="efectivo"`) pagos of the vendedor for the local-timezone day | `cortes/views.py:68-83`                                                |
| C2  | One corte per (vendedor, fecha) — DB partial unique + pre-check + IntegrityError guard                                    | `cortes/views.py:100-125`, `legacy/rassa_back/rassa/models.py:600-610` |
| C3  | `monto_teorico`/`diferencia` are creation-time snapshots; later payments do not retro-update                              | `legacy/rassa_back/rassa/models.py:584-593,615-620`                    |
| C4  | `teorico` endpoint caches 60 s; `create` never uses cache                                                                 | `cortes/views.py:138-162`                                              |

### Weekly settlements (liquidaciones)

| #   | Rule                                                                                                                                                                                                | Evidence                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| L1  | Admin-only module                                                                                                                                                                                   | `liquidaciones/views.py:268`                                                          |
| L2  | Week = ISO week; period is Monday→Sunday (fin exclusive in queries)                                                                                                                                 | `liquidaciones/views.py:47-50`                                                        |
| L3  | Only `entregado` pedidos containing DetallePedido lines of the agricultor's ProductoSemanal count; pedidos already liquidated **for that same agricultor** are excluded                             | `liquidaciones/views.py:53-96`                                                        |
| L4  | Multi-agricultor pedidos: only the agricultor's own line sums count                                                                                                                                 | `liquidaciones/views.py:113-124`                                                      |
| L5  | Commission rate 10 % (`COMISION_RASSA`); `comision` rounded HALF_UP to cents; `monto_liquidar = monto_ventas − comision`                                                                            | `liquidaciones/constants.py:6`, `liquidaciones/views.py:122-124`                      |
| L6  | Liquidación + `LiquidacionVenta` snapshot created atomically; snapshot keeps the detail stable even if pedido state changes later                                                                   | `liquidaciones/views.py:127-160`, `legacy/rassa_back/rassa/models.py:972-980`         |
| L7  | Anti-duplicate: any existing liquidación for (agricultor, periodo) in any state returns 409 — pagada periods can never be recalculated (double-payment guard); DB unique constraint is the backstop | `liquidaciones/views.py:193-216,450-454`, `legacy/rassa_back/rassa/models.py:961-966` |
| L8  | `marcar_pagada` is idempotent; creates `Pago(fk_pedido=NULL)`; inconsistent data states self-heal (pendiente+pago → pagada) or error (pagada sin pago)                                              | `liquidaciones/views.py:491-588`                                                      |
| L9  | Transient DB errors (deadlock 40P01, lock timeout 55P03, etc.) → 409 with `Retry-After` header; lock_timeout 5 s via `SET LOCAL`                                                                    | `liquidaciones/views.py:219-252`, `liquidaciones/constants.py:20-22`                  |

### Publications (publicaciones)

| #   | Rule                                                                                                                                                    | Evidence                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Pu1 | Publications and their products can only be created/edited/deleted/restored **on Mondays** (403 otherwise)                                              | `publicacion/views.py:42-70` (decorator applied at `:114,135,253,271,290,308`) |
| Pu2 | Create targets next Monday + ISO week number (never today, even if today is Monday)                                                                     | `publicacion/views.py:28-39`                                                   |
| Pu3 | Unique (agricultor, semana) — DB constraint; week range 1–52 — DB check                                                                                 | `legacy/rassa_back/rassa/models.py:351-363`                                    |
| Pu4 | Publish requires: estado borrador, ≥ 1 activo item, each with stock > 0, precio > 0, unidad, foto; per-item error report otherwise                      | `publicacion/views.py:150-199`                                                 |
| Pu5 | Lifecycle borrador→publicado→cerrado; deleting a borrador sets `cancelado`; products soft-delete (`activo`/`inactivo`) with restore only while borrador | `publicacion/views.py:135-148,201-221,290-324`                                 |
| Pu6 | Public `current` endpoint exposes only `publicado` publications of the current week, active items only, max 100                                         | `publicacion/views.py:327-352`                                                 |

### Stock & waste (mermas)

| #   | Rule                                                                                                      | Evidence                                                      |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| M1  | Merma registration decrements `ProductoSemanal.stock` under `select_for_update`; insufficient stock → 400 | `waste/views.py:127-143`                                      |
| M2  | Vendedor may register mermas only on their own pedidos; the producto_semanal must belong to the pedido    | `waste/views.py:121-125`, `waste/serializers.py` (`validate`) |
| M3  | Merma resumen groups by month/week with totals and top affected product (global, not per-period)          | `waste/views.py:172-323`                                      |

### Pickup scheduling (recolecciones)

| #   | Rule                                                                                                                                                                                                                                                                | Evidence                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| R1  | One active (non-cancelled) recolección per (agricultor, fecha) — DB partial unique is the final guarantee; serializer pre-check + agricultor-row lock are UX layers; fixed lock order prevents deadlocks; lock wait capped with `SET LOCAL statement_timeout='30s'` | `legacy/rassa_back/rassa/models.py:828-840`, `recoleccion/views.py:40-52,112-133,315-371` |
| R2  | `estado` forbidden in create/PATCH bodies (must use `/estado/` or `/cancelar/`)                                                                                                                                                                                     | `recoleccion/views.py:315-320,373-377`, `recoleccion/constants.py:20`                     |
| R3  | Strict state machine: `pendiente→{en_ruta,cancelado}`, `en_ruta→{recolectado,cancelado}`; terminal `{recolectado,cancelado}`; late-date exceptions (pendiente vencido → recolectado allowed, → en_ruta blocked)                                                     | `recoleccion/serializers.py:17-22,208-260`                                                |
| R4  | `/estado/` is strict (400 if same state); `/cancelar/` is idempotent (200)                                                                                                                                                                                          | `recoleccion/views.py:424-496`                                                            |
| R5  | Edit allowed only while `pendiente`                                                                                                                                                                                                                                 | `recoleccion/views.py:407-411`                                                            |
| R6  | Create requires future date; PATCH may backdate                                                                                                                                                                                                                     | `recoleccion/serializers.py:131-140`                                                      |
| R7  | IntegrityError discrimination by constraint name (Postgres `diag.constraint_name`, SQLite heuristic)                                                                                                                                                                | `recoleccion/views.py:72-109`                                                             |

### Families & chat

| #   | Rule                                                                                                                                                                                             | Evidence                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | A user can belong to only one active family                                                                                                                                                      | `familias/serializers.py:57-88`                                                                                                                                |
| F2  | Family soft-delete deactivates memberships and archives the family chat; restore requires a new chief and reactivates the chat                                                                   | `familias/views.py:38-120`                                                                                                                                     |
| F3  | Removing the chief clears `fk_jefe_familia` before deactivating the membership                                                                                                                   | `familias/views.py:219-233`                                                                                                                                    |
| F4  | Every family gets an idempotent group conversation synced with the family (chief = chat admin) via `chat_sync` service                                                                           | `legacy/rassa_back/rassa/blueprints/chat/services/chat_sync.py:31-157`                                                                                         |
| F5  | Family chat name follows the family name unless `nombre_override` is set; family chats cannot be manually renamed/membership-managed                                                             | `chat/views.py:376-408,411-459,462-496`, `legacy/rassa_back/rassa/blueprints/chat/signals.py:11-27` (post_save on Familia → `sync_family_chat_name` on commit) |
| Ch1 | Private conversation creation is idempotent (200 when it already exists — frontend contract)                                                                                                     | `chat/views.py:265-300`                                                                                                                                        |
| Ch2 | Edit/delete messages: own messages only, 15-minute window (`CHAT_EDIT_WINDOW_MINUTES`)                                                                                                           | `chat/views.py:157-185,210-238`, `chat/serializers.py:102-122`, `legacy/rassa_back/rassa/settings.py:243`                                                      |
| Ch3 | Deleting a message sets `estado=False` (soft); read-marking is a bulk update excluding own messages                                                                                              | `chat/views.py:188-238`                                                                                                                                        |
| Ch4 | Chat attachments: ≤ 20 MB, extension whitelist per type, MIME verified with python-magic when available; stored at `MEDIA_ROOT/documentos/{uuid}_{safe_name}` via tmp-file + rename after commit | `chat/serializers.py:51-99`, `chat/views.py:598-667`                                                                                                           |

### Product images & Google Drive

| #   | Rule                                                                                                                                                          | Evidence                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| G1  | Agricultor ownership: only products they have published (Admin bypass)                                                                                        | `legacy/rassa_back/rassa/permissions/ownership.py:12-43`                                                                       |
| G2  | Upload validation: MIME whitelist, magic-byte check, ≤ 10 MB (blueprint) / ≤ 5 MB (productos_views), filename sanitized                                       | `legacy/rassa_back/rassa/services/drive_config.py:9-32`, `google_drive.py:161-201,265-297`, `productos_views.py:27-35,151-190` |
| G3  | Only one principal image per product (DB partial unique + transactional demote/promote)                                                                       | `legacy/rassa_back/rassa/models.py:791-800`, `producto_imagen/views.py:334-374`, `productos_views.py:193-210,355-377`          |
| G4  | Deleting an image deletes the Drive file; if Drive delete fails, the row survives with `eliminar_pendiente=True` for later cleanup (and is hidden from lists) | `producto_imagen/views.py:243-295`                                                                                             |
| G5  | If a DB save fails after a Drive upload, the orphan Drive file is deleted (rollback defensivo)                                                                | `producto_imagen/views.py:195-208,216-223`, `productos_views.py:267-278`                                                       |
| G6  | Drive images are made public (`anyone→reader`) by design; documented trade-off in module docstring                                                            | `google_drive.py:12-41,373-387,495-510`                                                                                        |

### User administration

| #   | Rule                                                                                                                              | Evidence                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| U1  | Admin cannot change their own role or toggle their own state                                                                      | `admin_views.py:220-224,276-281`                        |
| U2  | Cannot demote/deactivate the last active admin (row-locked count check; `select_for_update(nowait=True)`, OperationalError → 423) | `admin_views.py:32-51,120-122`                          |
| U3  | Deactivating a user only flips `Usuario.estado` — login does NOT check it (see §10)                                               | `admin_views.py:264-319`, `auth_serializers.py:128-143` |

### Cross-cutting mechanics

- **Pagination**: global `PageNumberPagination` page size 20 (`settings.py:113-114`); `CatalogPagination` (20), `AdminUsuarioPagination` (20), `ProductoImagenPagination` (20, client-tunable to 100 via `page_size`, max 100). Trash lists and several chat endpoints are unpaginated (`views.py:682`, `chat/views.py:528-595`).
- **Filtering**: django-filter `Filterset` exists only for Producto (`legacy/rassa_back/rassa/filters.py:8-29`). All other filtering is hand-rolled query-param handling with explicit validation and Spanish error messages (recolecciones `views.py:260-295`, liquidaciones `views.py:281-305`, mermas `views.py:91-110`, admin usuarios `admin_views.py:124-164`, logs `logs/views.py:19-36`).
- **Ordering**: `SearchFilter`/`OrderingFilter` are configured globally (`settings.py:116-120`) but `search_fields`/`ordering_fields` are declared only on `ProductoListView` (`productos_views.py:59-60`).
- **Soft delete**: `estado=False` everywhere (catalogs, familias, mensajes, conversaciones, producto_semanal, mermas); trash/restore/permanent endpoints exist for municipios, localidades, categorías, unidades, familias (§3.2/3.3/3.10). Publicaciones use a 4-value char `estado` lifecycle instead. Producto has soft delete but **no** trash/restore endpoints.
- **Throttling**: 20+ scoped rates (`settings.py:174-213`): anonymous 60/min, user 1000/h; register/login 30/min; change_password 10/h; catalog read/write; publicaciones (write 10/h); imagen_upload 20/h; chat read/write; admin_users; pagos read/write; liquidaciones calcular 30/h / marcar_pagada 60/h; recolecciones read 60/min / write 100/h. All throttles are disabled when running tests (`settings.py:215-217`).
- **Concurrency discipline**: `select_for_update` with fixed row ordering is used in pedido create, pago create, corte create, liquidación calcular/marcar_pagada, recolección create/edit, productoimagen set-principal (`nowait`), admin usuario mutations (`nowait`).

---

## 6. Background jobs & commands

**Status: Confirmed. No scheduler exists (no Celery, no cron config in-repo).**

Management commands (`legacy/rassa_back/rassa/management/commands/`):

| Command                            | Purpose                                                                                                                                                                                                                                                                  | Notes                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `seed_rassa_data.py` (2,473 lines) | Seeds all 32 legacy tables: 4 roles, 7 estados de pedido (incl. legacy `activo`), 4 decisiones de merma, 3 tipos de pago, Nayarit municipios/localidades, demo users/personas/familias/productos/pedidos/pagos/chat/mermas/cortes/recolecciones, demo WAV/PNG generation | `--clear` flag; `update_or_create` per row (`seed_rassa_data.py:97-380`) |
| `authorize_drive.py`               | One-time OAuth2 flow for Google Drive; stores refresh token in `.env`                                                                                                                                                                                                    | `authorize_drive.py:1-60`; local redirect `http://localhost:8090/`       |
| `cleanup_orphan_drive_files.py`    | Retries Drive deletion for `ProductoImagen.eliminar_pendiente=True`; dry-run by default, `--delete` executes; treats Drive 404 as success                                                                                                                                | `cleanup_orphan_drive_files.py:1-79`                                     |
| `reset_sequences.py`               | Re-syncs PostgreSQL sequences with max IDs after raw inserts                                                                                                                                                                                                             | Postgres-only; `--dry-run`                                               |
| `sanitizar_documentos.py`          | Renames chat attachment files with unsafe characters (e.g. `%20` from React Native) and updates `Documento.url_documento`                                                                                                                                                | `--dry-run`                                                              |

**Signals** (registered in `legacy/rassa_back/rassa/apps.py:29-33`):

- `rassa.signals` (`legacy/rassa_back/rassa/signals.py:24-67`): `pre_save`/`post_save` on `PedidoCabecera` write `HistorialEstadoPedido` as a **safety net** for out-of-band state changes (Django admin, commands); skipped when `update_fields` is passed because the view writes history inline with the actor.
- `rassa.blueprints.chat.signals` (`chat/signals.py:11-27`): on `Familia` update (not create), syncs the family chat name after commit unless `nombre_override`.

**Scheduled tasks**: none found. `cleanup_orphan_drive_files` is the only maintenance-like
job and must be run manually (no in-repo cron/systemd/celery config).

---

## 7. External integrations

**Status: Confirmed.**

| Integration                       | Purpose                                                                                                    | Files                                                                                          | Key facts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Drive (Drive v3 API)       | Storage for product images (both image pipelines) and **not** for chat attachments (those are local files) | `legacy/rassa_back/rassa/services/google_drive.py`, `drive_config.py`, both image views (§3.4) | OAuth2 with refresh token from env (scope `https://www.googleapis.com/auth/drive.file` — `drive_config.py:7`); service cached per process with thread lock; 60 s API timeout; 3 retries with exponential backoff on 429/5xx and network errors (`google_drive.py:219-262`); files under a configurable folder; public read permission applied intentionally (`google_drive.py:12-41`); two upload modes: public-immediately (`upload_image`) and private-then-`make_public` after commit (`upload_image_bytes`) |
| Google OAuth2 device/browser flow | One-time authorization to obtain the refresh token                                                         | `management/commands/authorize_drive.py`                                                       | Local redirect URI `http://localhost:8090/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Email                             | **None.** No email backend configured beyond Django defaults; no send usage found anywhere in the codebase | —                                                                                              | Confirmed by absence: no `EMAIL_*` settings keys and no `send_mail`/`EmailMessage` calls                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Inference**: the `requirements.txt` includes `google-auth-httplib2`/`google-auth-oauthlib`
exclusively for the Drive flow above; no other Google API surface is referenced in the code
(evidence: only `googleapiclient` imports resolve to Drive v3 builds in `google_drive.py`).

---

## 8. Configuration surface

**Status: Confirmed. Key names only — no values.**

### Environment keys (python-decouple, `.env`)

Read in `legacy/rassa_back/rassa/settings.py` unless noted:

| Key                                                                                    | Purpose                                                                                                   |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SECRET_KEY`                                                                           | Django secret; refuses default `changeme-in-production` when `DEBUG=False` (`settings.py:27-29`)          |
| `DEBUG`                                                                                | Debug mode                                                                                                |
| `ALLOWED_HOSTS`                                                                        | Comma-separated hosts                                                                                     |
| `DATABASE_URL`                                                                         | Postgres URL via dj-database-url; **falls back to SQLite** `db.sqlite3` when absent (`settings.py:94-95`) |
| `CORS_ALLOWED_ORIGINS`                                                                 | Comma-separated origins (defaults target localhost:8081/19006 — Expo dev servers)                         |
| `TRUSTED_PROXIES`                                                                      | Comma-separated proxy IPs trusted for `X-Forwarded-For` (`settings.py:255-256`, `logs/utils.py`)          |
| `GOOGLE_DRIVE_CREDENTIALS_PATH`                                                        | Alternate authorized-user JSON file path                                                                  |
| `GOOGLE_DRIVE_FOLDER_ID`                                                               | Destination Drive folder                                                                                  |
| `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` / `GOOGLE_DRIVE_REFRESH_TOKEN` | OAuth2 credentials (also read directly via decouple in `google_drive.py:87-96` and `authorize_drive.py`)  |

### Settings-only constants (not env-driven)

`EXCLUDED_PATHS` (audit-log exclusions), `ADMIN_ROLE_NAME`, `FILE_UPLOAD_MAX_MEMORY_SIZE`
(5 MB), `REST_FRAMEWORK` block (auth classes, default permissions, pagination, renderer,
filter backends, throttle classes + 20 rate scopes), `SIMPLE_JWT` block, `CORS_ALLOW_CREDENTIALS`,
`LANGUAGE_CODE=es-ar`, `TIME_ZONE=America/Argentina/Buenos_Aires`, `USE_TZ`,
`STATIC_URL`/`STATIC_ROOT`, `MEDIA_URL`/`MEDIA_ROOT`, `DEFAULT_AUTO_FIELD=BigAutoField`,
`CHAT_EDIT_WINDOW_MINUTES=15`, `IVA_RATE=0.21`, `LOGGING` (console only).

### Middleware order (`settings.py:60-70`)

`CorsMiddleware` first, then standard Django security/session/common/CSRF/auth/messages/
XFrameOptions, and `logs.middleware.ActivityLogMiddleware` last (response-phase audit logging).

### Django admin

Only `DecisionMerma` and `Merma` are registered (`legacy/rassa_back/rassa/admin.py`).

---

## 9. Testing surface

**Status: Confirmed (inventory). Depth: brief per task instructions.**

24 test files under `legacy/rassa_back/rassa/tests/` (~17,000 lines total) plus a root
`conftest.py` that mocks `googleapiclient` before Django loads (workaround for a module-level
import in the producto_imagen blueprint — `conftest.py:1-80`) and a Python 3.14/Django 5.0
`Context.__copy__` patch in `rassa/tests/__init__.py`.

| Test file                                                                                                         | Coverage focus                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `test_profile_and_auth_endpoints.py` (844 l.)                                                                     | register, profile, change-password endpoints                                          |
| `test_auth_serializers.py`                                                                                        | auth serializer unit tests                                                            |
| `test_admin_user_protection.py`                                                                                   | single-admin protection, self-edit blocks                                             |
| `test_role_permissions.py` (242 l.)                                                                               | HasRole/aliases RBAC unit tests                                                       |
| `test_catalogos.py` (1,364 l.), `test_catalog_crud.py`                                                            | municipios/localidades CRUD, trash/restore/permanent                                  |
| `test_producto_crud.py` (349 l.), `test_producto_edge_cases.py` (771 l.), `test_producto_imagen_crud.py` (606 l.) | product CRUD + filters + image endpoints                                              |
| `test_publicaciones.py` (869 l.), `test_publicaciones_exhaustivo.py` (616 l.)                                     | Monday rule, publish validation, security edge cases                                  |
| `test_pedidos.py` (1,113 l.)                                                                                      | cart validation, stock locks, credit limit, state machine                             |
| `test_pagos.py` (935 l.)                                                                                          | pago preconditions, folio, idempotency/TOCTOU                                         |
| `test_liquidaciones.py` (1,938 l.)                                                                                | calculation, snapshots, duplicates, idempotent payment                                |
| `test_cortes.py` (539 l.)                                                                                         | teorico computation, uniqueness, snapshots                                            |
| `test_recolecciones.py` (1,192 l.)                                                                                | slot uniqueness, state machine, late-completion rules                                 |
| `test_chat.py` (1,150 l.), `test_familias.py` (520 l.), `test_familias_chat_integration.py` (297 l.)              | chat flows, family CRUD, family↔chat sync                                             |
| `test_waste.py` (1,008 l.)                                                                                        | mermas + decisiones + resumen                                                         |
| `test_google_drive.py` (352 l.), `test_cleanup_orphan_drive_files.py` (142 l.)                                    | Drive service behavior, orphan cleanup                                                |
| `test_migrations.py` (258 l.)                                                                                     | migration graph consistency, squash replaces expected set, data-migration idempotency |
| `test_seed_rassa_data.py` (102 l.)                                                                                | seed command                                                                          |
| `test_sanitizar_documentos.py` (88 l.), `test_utils.py` (29 l.)                                                   | filename sanitizer, shared utils                                                      |

CI (`legacy/rassa_back/.github/workflows/ci.yml`): ruff lint → pytest on Postgres 16 →
`manage.py check` + `makemigrations --check --dry-run`. Local: `make ci` (Makefile).

---

## 10. Non-obvious behaviors & gotchas

**Status: Confirmed (each item cites evidence).**

1. **`Usuario.estado` is not checked at login.** `CustomTokenObtainPairSerializer` verifies
   `user.is_active` (the Django user) but not the business `Usuario.estado` flag
   (`legacy/rassa_back/rassa/auth_serializers.py:128-143`). A deactivated `Usuario` can keep
   using valid JWTs; only some modules check `estado` (chat: `chat/views.py:38-59,688-695`;
   admin serializers; recolección validation of the _target_ agricultor). Enforcement is
   inconsistent across modules.
2. **Refresh-token rotation without post-rotation blacklist.** `ROTATE_REFRESH_TOKENS=True`
   but `BLACKLIST_AFTER_ROTATION` is unset (`settings.py:165-172`), so rotated-out refresh
   tokens remain usable until their 7-day expiry. Only change-password blacklists a supplied
   token.
3. **Two parallel product-image upload pipelines with different semantics.**
   `ProductoImagenViewSet` (blueprint, `/imagenes/`) uploads publicly-visible Drive files
   immediately and supports URL-only images; `ProductoImagenUploadView` (`/imagen/`) uploads
   **privately** and calls `make_public` only after the DB commit, always sets a principal
   image, and syncs the legacy `Producto.imagen` column (`producto_imagen/views.py` vs
   `productos_views.py:213-289`). Size limits also differ (10 MB vs 5 MB). Deleting via the
   legacy path (`productos_views.py:292-333`) hard-deletes the row even if the Drive delete
   failed (row is lost, file stays orphaned), unlike the blueprint path which marks
   `eliminar_pendiente`.
4. **Duplicate class name `ProductoImagenSerializer`** exists in two modules with different
   field sets (`legacy/rassa_back/rassa/productos_serializers.py:20` vs
   `legacy/rassa_back/rassa/blueprints/producto_imagen/serializers.py:8`).
5. **`admin_serializers.py` is a single physical line** (zero newlines — `wc -l` reports 0);
   content is valid Python but effectively unreadable/unlintable in diff form.
6. **`logs/models.py` is empty**; the `Log` model lives in `rassa/models.py:628-644`
   (`db_table="logs"`). The `logs` app contributes views/middleware only.
7. **`PedidoCabecera.fecha_expiracion` is never set by the create flow** — the expiry check
   (`es_pedido_expirado`) is effectively dormant except for seeded rows
   (`pedido/serializers.py:21-32`, `pedido/views.py:235-239`).
8. **Stock can go negative in aggregate scenarios**: pedido create and merma registration
   each decrement stock under lock, but there is no DB CHECK on `producto_semanal.stock ≥ 0`
   (SQL archive had one, migrations do not — see database audit §7), and the two flows only
   check against the current value.
9. **Response envelope is inconsistent by design in places**: pagos and cortes return raw
   payloads; `tipos_pago` returns a bare array to satisfy the frontend
   (`pagos/views.py:208-213`); errors are raw DRF error dicts with no global exception
   handler (documented in `recoleccion/views.py:138-141`).
10. **Throttles are silently disabled in tests** (`settings.py:215-217`) — rate-limit bugs
    are invisible to the suite.
11. **PublicTrashList reads are `AllowAny`** — municipios/localidades trash endpoints are
    public (`views.py:667-707`), exposing inactive catalog names to unauthenticated callers.
12. **Static media served only in DEBUG**: `/documentos/` static mount exists only when
    `settings.DEBUG` (`urls.py:176-177`); chat attachments 404 in production serving setups
    unless the web server serves `MEDIA_ROOT` — the `sanitizar_documentos` command exists
    precisely because of such path/URL mismatches (`management/commands/sanitizar_documentos.py:1-17`).
13. **Docs drift**: `legacy/rassa_back/docs/USUARIOS_PRUEBA.md` references
    `POST /api/auth/login-api/`, which does not exist in the URL config (actual login is
    `POST /api/token/`); the README references `setup.sh`/`start.sh`/`setup.ps1`/`start.ps1`
    which are absent from this checkout (only `scripts/test_setup_helpers.sh` and
    `scripts/test_setup_ps1.ps1` exist).
14. **Locale/timezone mismatch in data**: the app locale is `es-ar` with Argentina TZ
    (`settings.py:228-231`) while seed geographic data is Nayarit, México
    (`seed_rassa_data.py:316+` comment block and `_seed_municipios`). Corte day boundaries
    are computed in the Django `TIME_ZONE` (`cortes/views.py:71-75`).
15. **`Log.ip` can receive an empty string** from `_log()` (`views.py:36` uses raw
    `REMOTE_ADDR` while the middleware uses `get_client_ip` defaulting to `0.0.0.0`);
    `GenericIPAddressField` would reject empty, and `_log` swallows the failure silently
    (`views.py:39-40`).
16. **`check_postgresql_version`** enforces PostgreSQL ≥ 15 at deploy because migration 0018
    uses `nulls_distinct=True` (`legacy/rassa_back/rassa/checks.py:1-35`).
17. **EstadoPedido `activo` (id 7)** is seeded but unused by any flow (`seed_rassa_data.py:342-347`;
    no reference in views/serializers) — legacy residue.
18. **`Unidad.tipo` is kept in sync with `nombre`** purely for legacy-column compatibility
    (`catalogos_serializers.py:78-91`).

---

## 11. Gaps and open questions

Items below are missing/ambiguous in the repos; no solutions are proposed here.

1. **Seller/farmer onboarding scope**: public registration only allows buyer/seller
   (`auth_serializers.py:210`); there is no admin endpoint to create Vendedores, and no
   self-service farmer upgrade path other than `/api/auth/create-farmer/`. How are Vendedores
   provisioned? (Only the seed command creates them.)
2. **Vendedor assignment to pedidos**: `fk_vendedor` is never written by any API flow found
   (create flow has no vendedor field; no assignment endpoint). Evidence:
   `pedido/serializers.py:202-205`, `pedido/views.py:114-194`. Open question: is assignment
   manual/seed-only in the legacy system?
3. **Email/reset flows**: no password-reset, no email verification, no invitation flow
   exists. Confirm whether the new app must add them.
4. **Real-time chat delivery**: chat is pure request/response (no websockets/ASGI, §1).
   Clients presumably poll `GET /api/chat/usuarios/conversaciones/`. Confirm polling cadence
   expectations from the mobile app (not in this repo).
5. **`Pago` for liquidaciones vs `Recibo`**: `Recibo` model exists
   (`legacy/rassa_back/rassa/models.py:902-919`) but **no API endpoint creates or reads
   Recibos** (no serializer/view references it except the seed command). Confirm whether
   receipts are dead code or produced elsewhere (e.g., frontend-rendered from `PagoOutputSerializer`).
6. **`LimiteCliente` provisioning**: no endpoint creates credit limits (only the seed
   command). Confirm how limits are managed operationally.
7. **Bruno coverage holes**: `/api/logs/`, `/api/auth/health/`, and the legacy
   `/api/productos/{id}/imagen/` DELETE/PATCH paths have no bruno request files. Are these
   intentionally untested externally?
8. **Deployment topology**: no Docker/compose files, no gunicorn config file (only the
   dependency), no production `ALLOWED_HOSTS`/CORS values, no static/media strategy for
   production (DEBUG-only media mount, §10.12). All deployment knowledge is outside this repo.
9. **`DEBUG=False` SQLite fallback**: `DATABASE_URL` defaults to SQLite
   (`settings.py:94-95`), but several features assume PostgreSQL (advisory locks, partial
   unique semantics, `nulls_distinct`, `SET LOCAL`). Confirm whether SQLite is ever a
   supported runtime or only a test convenience.
10. **Mobile contract source of truth**: the response-envelope exceptions (§10.9) suggest
    endpoint-specific frontend expectations, but no OpenAPI/schema spec exists in the repo
    (`rassa_bruno_collection.json` is a small exported subset, 7.5 KB). Confirm whether any
    external API contract document exists.
11. **Family chat membership vs `FamiliaUsuario` soft-delete races**: `chat_sync` catches
    broad exceptions and continues (`familias/views.py:47-54,105-108,234-248`), logging via
    the audit log. Whether chat desynchronization is monitored/repaired automatically (only
    the admin `/sincronizar/` endpoint exists) is undocumented.
