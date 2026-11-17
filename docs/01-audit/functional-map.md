# Functional Map — Legacy RassaJala (frontend ↔ backend ↔ database correspondence)

This document maps what the legacy system's frontends actually call to what the legacy
backend exposes and what the database persists. It is the correspondence layer between
the three primary audit documents (`backend-audit.md`, `database-audit.md`,
`frontend-audit.md`) and the factual basis for scoping the new independent app
(React + TS, Bun + tRPC, Prisma, Supabase Postgres, RxDB, offline-first PWA). The legacy
tree is reference only; nothing here proposes designs or data-model changes.

Every claim cites either an audit-doc section or a direct repo-relative path under
`legacy/` (with line numbers). Conflicts found between the source audits are called out,
not silently absorbed.

## Quick path

1. [Method & sources](#1-method--sources) — what was read, what was spot-checked.
2. [Correspondence matrix](#2-correspondence-matrix) — the core: 14 functional domains.
3. [Lifecycle data flows](#3-lifecycle-data-flows) — six evidenced end-to-end narratives.
4. [Correspondence findings](#4-correspondence-findings) — matches, mismatches, dead ends.
5. [Feature completeness assessment](#5-feature-completeness-assessment) — per domain × app.

---

## 1. Method & sources

### 1.1 What was read

- `docs/01-audit/backend-audit.md` — full read (Django/DRF: 14 resource families, auth/RBAC,
  business rules, 18 gotchas, open questions).
- `docs/01-audit/database-audit.md` — full read (34 entities, 31 migrations, ER diagram,
  lifecycle/integrity rules).
- `docs/01-audit/frontend-audit.md` — full read (Expo mobile + Vite web: module inventory,
  106 API operations, mock-vs-real map, checkout guard, dead code).

The supplementary engram observations (mobile/web exploration reports) were **not**
needed: every correspondence question left open by the three docs was closed by a
targeted spot check (below) or is explicitly registered as unresolved in
`audit-findings.md` §5.

### 1.2 Spot checks performed (read-only, targeted)

| #   | Open question from the audits                                                                                                                     | Method                          | Result                                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | `/pedidos/{id}/historial` trailing-slash anomaly (frontend-audit §4.4)                                                                            | Read router + settings          | Route is router-generated **with** trailing slash; `CommonMiddleware` is installed and `APPEND_SLASH` is not overridden. Slash-less GET is tolerated only via Django's append-slash redirect (Inference — redirect behavior not executed)                                                              | `legacy/rassa_back/rassa/blueprints/pedido/urls.py:8-12`, `legacy/rassa_back/rassa/settings.py:64`                                                                                                                                                                                                                                                                                                                                               |
| S2  | Does the backend honor the `Idempotency-Key` header (frontend-audit §11.6)?                                                                       | Grep `legacy/rassa_back/rassa/` | **No server-side handling anywhere.** All "idempotencia" hits are unrelated (liquidación `marcar-pagada`, recolección `/cancelar/`, test names)                                                                                                                                                        | grep over `legacy/rassa_back/rassa/` (zero view/serializer/middleware hits)                                                                                                                                                                                                                                                                                                                                                                      |
| S3  | Mobile `CrudListScreen` toggle mechanism — verb and URL unknown (frontend-audit §11.12)                                                           | Read component + screen configs | Toggle is **PATCH** (not POST). URL is `/{id}/estado/` when the screen configures `toggleEndpoint` (municipios, localidades) and plain `/{id}/` with body `{estado}` otherwise (categorías, unidades). Backend supports both shapes (`estado` is a **writable** field on the category/unit serializer) | `legacy/rassa_front/src/components/CrudListScreen.tsx:433,566-580`, `legacy/rassa_front/src/screens/admin/LocalidadListScreen.tsx:56`, `legacy/rassa_front/src/screens/admin/MunicipioListScreen.tsx:342`, `legacy/rassa_front/src/screens/admin/CategoryListScreen.tsx:19`, `legacy/rassa_front/src/screens/admin/UnitListScreen.tsx:145`, `legacy/rassa_back/rassa/views.py:607-640`, `legacy/rassa_back/rassa/catalogos_serializers.py:50-57` |
| S4  | Does `GET /localidades/` really support `?municipio_id=` (frontend-audit §3.2 vs backend-audit §3.2)?                                             | Read view helper                | Yes — dedicated `_resolve_municipio_id` validates and applies the query-param branch                                                                                                                                                                                                                   | `legacy/rassa_back/rassa/views.py:505-528`                                                                                                                                                                                                                                                                                                                                                                                                       |
| S5  | Web wizard fetches `GET /productos/?page_size=200` — is `page_size` honored?                                                                      | Grep pagination config          | **No.** `page_size_query_param` exists only on `ProductoImagenPagination`; `ProductoListView` uses the default pagination (page size 20, no query-param override) — the param is silently ignored                                                                                                      | `legacy/rassa_back/rassa/blueprints/producto_imagen/views.py:48`, `legacy/rassa_back/rassa/productos_views.py:38`, `legacy/rassa_back/rassa/settings.py:113-114`                                                                                                                                                                                                                                                                                 |
| S6  | Do `/mermas/resumen/` filter params used by both apps (`fecha_desde`, `fecha_hasta`, `producto_id`, `agrupar_por`) exist server-side?             | Read view                       | Yes, all four are parsed and validated                                                                                                                                                                                                                                                                 | `legacy/rassa_back/rassa/blueprints/waste/views.py:180-236`                                                                                                                                                                                                                                                                                                                                                                                      |
| S7  | Mobile has a `LocalidadTrashScreen` but the frontend audit's consolidated inventory omits `GET /localidades/trash/`                               | Read trash screen               | Confirmed used: `TrashListScreen` builds `GET {endpoint}trash/` — the inventory omission is real but harmless                                                                                                                                                                                          | `legacy/rassa_front/src/components/TrashListScreen.tsx:65`                                                                                                                                                                                                                                                                                                                                                                                       |
| S8  | Frontend claims liquidación business errors arrive as `ok:true` on HTTP 400/409 (frontend-audit §3.9) — does the backend do that?                 | Read response helpers           | **Contradicted.** Errors are built with `_ok(..., status_code=400/404/409/500)`, and `_ok` sets `ok = status_code < 400` → envelope is `ok:false` on every error status. The frontend's _caller behavior_ (branch on HTTP status) stays safe regardless                                                | `legacy/rassa_back/rassa/blueprints/liquidaciones/views.py:212-218,247-252,329-343,594-598`, `legacy/rassa_back/rassa/views.py:43-49`, `legacy/rassa_front/web/src/services/settlements.ts:184-185`                                                                                                                                                                                                                                              |
| S9  | Is `GET /pedidos/` wrapped in the `{ok,data,message}` envelope (backend-audit §3 blanket statement) or raw (frontend-audit §4.2)?                 | Read viewset                    | **Raw DRF page body** `{count,next,previous,results}` — `PedidoViewSet` has no list override and no envelope mixin; the wrap happens only on create/status/historial via `ok_response`. The frontend audit's per-endpoint map is correct; the backend audit's blanket statement is not                 | `legacy/rassa_back/rassa/blueprints/pedido/views.py:63,117-333`                                                                                                                                                                                                                                                                                                                                                                                  |
| S10 | Can farmers really create/update/delete products (frontend farmer screens are REAL), given backend-audit §3.4 says product writes are Admin-only? | Grep permission classes         | **Admin-only writes confirmed**: `IsAdminOrReadOnly` on list/create and detail (safe methods for any authenticated user, writes for Admin only). No role-based override exists in the module                                                                                                           | `legacy/rassa_back/rassa/productos_views.py:18,57,95,223,295`                                                                                                                                                                                                                                                                                                                                                                                    |

### 1.3 Conventions used below

- Frontend paths are shown as the frontend writes them (relative to the axios base URL:
  `/api` on mobile; `/api` via the Vite dev proxy on web). Backend paths include the
  `/api` prefix. They denote the same URL unless flagged.
- Endpoint tables carry a **Used by** column: **B** both apps · **M** mobile-only ·
  **W** web-only · **—** no frontend usage.
- **Envelope** column summarizes the response shape the frontend must unwrap
  (per-endpoint; there is no global contract — see §4.3).
- Coverage marks: **full** (every backend route of the family has frontend usage and
  vice versa) · **partial** (real usage but some side is unused) ·
  **frontend-mock-only** (UI exists but talks to fake data) · **backend-only** (backend
  surface with no frontend caller) · **stub** (placeholder UI, no data).

---

## 2. Correspondence matrix

### 2.1 Auth & usuarios (incl. admin user management)

| Frontend modules (status)                                                                                                                                                                                  | Endpoints (method + path)                      | Used by                         | Envelope                          | Backend family          | DB entities                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------- | --------------------------------- | ----------------------- | ----------------------------------------------------------- |
| M: `LoginScreen`, `RegisterScreen`, `AuthContext` (REAL) · W: `Login`, `Register`, `AuthProvider` (REAL) · M: `UserManagementScreen`, `UserFormScreen` (REAL) · W: `AdminUsers`, `NuevoUsuarioForm` (REAL) | POST `/token/`                                 | B                               | `{access,refresh}` (raw JWT pair) | backend-audit §3.1 auth | `auth_user` (Django-managed), `usuario`, `persona`, `roles` |
|                                                                                                                                                                                                            | POST `/token/refresh/`                         | B                               | raw JWT pair                      | §3.1                    | token_blacklist tables                                      |
|                                                                                                                                                                                                            | GET `/auth/me/`                                | B                               | envelope (`{ok,data,message}`)    | §3.1                    | `usuario`, `persona`                                        |
|                                                                                                                                                                                                            | PATCH `/auth/me/`                              | B                               | envelope                          | §3.1                    | `usuario`, `persona`                                        |
|                                                                                                                                                                                                            | POST `/auth/register/`                         | B                               | envelope (access+refresh+user)    | §3.1                    | `auth_user`, `persona`, `usuario`                           |
|                                                                                                                                                                                                            | POST `/auth/create-farmer/`                    | B (admin-created farmers)       | envelope                          | §3.1                    | same                                                        |
|                                                                                                                                                                                                            | POST `/auth/change-password/`                  | B                               | envelope                          | §3.1                    | `auth_user`, blacklist                                      |
|                                                                                                                                                                                                            | GET `/auth/search-users/?q=&include_assigned=` | B (family head / chat search)   | envelope                          | §3.1                    | `usuario`, `familia_usuario`                                |
|                                                                                                                                                                                                            | GET `/admin/usuarios/` (+ `?rol=&estado=`)     | B (admin mgmt + farmer pickers) | envelope-wrapped DRF page         | §3.1 admin              | `usuario`, `persona`, `roles`                               |
|                                                                                                                                                                                                            | PATCH `/admin/usuarios/{id}/`                  | B (role change)                 | envelope                          | §3.1 admin              | `usuario`, `roles`, `persona`                               |
|                                                                                                                                                                                                            | PATCH `/admin/usuarios/{id}/toggle-estado/`    | B (activate/deactivate)         | envelope                          | §3.1 admin              | `usuario`                                                   |
| — (no frontend caller)                                                                                                                                                                                     | GET `/auth/health/`                            | —                               | plain                             | §3.1                    | —                                                           |
| — (no frontend caller)                                                                                                                                                                                     | GET `/admin/usuarios/{id}/`                    | —                               | envelope                          | §3.1 admin              | `usuario`                                                   |
| — (no frontend caller)                                                                                                                                                                                     | GET `/logs/`, GET `/logs/{id}/`                | —                               | paginated                         | §3.1 logs               | `logs`                                                      |

**Coverage: full** for the used operations. Backend-only residue: health probe, single-user
admin retrieve, and the whole audit-log API (nothing in either frontend reads `logs`).
Open correspondence gaps: no vendedor provisioning endpoint and no vendedor-assignment
endpoint (backend-audit §11.1–11.2); `LimiteCliente` has no write API at all (§11.6).

### 2.2 Catálogos — municipios / localidades

| Frontend modules (status)                                                                                            | Endpoints (method + path)                                                                                   | Used by                                                                                                       | Envelope              | Backend family     | DB entities |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------ | ----------- |
| M: `MunicipioListScreen` + trash (REAL, `CrudListScreen`/`TrashListScreen`) · W: `AdminMunicipios` (REAL, 842 lines) | GET `/municipios/`                                                                                          | B                                                                                                             | envelope-wrapped page | backend-audit §3.2 | `municipio` |
|                                                                                                                      | GET `/municipios/trash/`                                                                                    | B                                                                                                             | envelope-wrapped page | §3.2               | `municipio` |
|                                                                                                                      | POST `/municipios/`                                                                                         | B                                                                                                             | envelope 201          | §3.2               | `municipio` |
|                                                                                                                      | PATCH `/municipios/{id}/`                                                                                   | B (edit)                                                                                                      | envelope              | §3.2               | `municipio` |
|                                                                                                                      | PATCH `/municipios/{id}/estado/` `{estado}`                                                                 | **B** (W toggle; M toggle via `toggleEndpoint: 'estado/'` — spot check S3 corrects frontend-audit's "W-only") | envelope              | §3.2               | `municipio` |
|                                                                                                                      | DELETE `/municipios/{id}/`                                                                                  | B (soft delete)                                                                                               | envelope              | §3.2               | `municipio` |
|                                                                                                                      | POST `/municipios/{id}/restore/`, POST `/municipios/{id}/permanent/`                                        | B                                                                                                             | envelope              | §3.2               | `municipio` |
|                                                                                                                      | GET `/municipios/{id}/localidades/`                                                                         | W (profile location selector)                                                                                 | list                  | §3.2               | `localidad` |
| M: `LocalidadListScreen` + trash (REAL) · W: `AdminLocalidades` (REAL, 1014 lines)                                   | GET `/localidades/` (+ `?municipio_id=`)                                                                    | B (M scopes by query param — spot check S4; W uses admin list)                                                | envelope-wrapped page | §3.2               | `localidad` |
|                                                                                                                      | GET `/localidades/trash/`                                                                                   | M (spot check S7 — omitted from frontend-audit §4.1 inventory)                                                | envelope-wrapped page | §3.2               | `localidad` |
|                                                                                                                      | POST / PATCH / DELETE `/localidades/{id}/`, POST `.../restore/`, POST `.../permanent/`, PATCH `.../estado/` | B                                                                                                             | envelope              | §3.2               | `localidad` |

**Coverage: full.** The one genuine dual-convention is read-side scoping (query param on
mobile vs nested path on web — both exist server-side). Trash reads are `AllowAny`
server-side (backend-audit §10.11).

### 2.3 Catálogos — categorías / unidades

| Frontend modules (status)                              | Endpoints (method + path)                                                          | Used by              | Envelope                                                                                         | Backend family                        | DB entities                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------- |
| M: `CategoryListScreen` + `CategoryTrashScreen` (REAL) | GET `/categorias/`, GET `/categorias/trash/`                                       | B (read) / M (trash) | envelope-wrapped page                                                                            | backend-audit §3.3 `CatalogViewSet`   | `categoria_producto`                                 |
|                                                        | POST `/categorias/`, PATCH `/categorias/{id}/`, DELETE `/categorias/{id}/`         | **M only**           | envelope                                                                                         | §3.3                                  | `categoria_producto`                                 |
|                                                        | PATCH `/categorias/{id}/` `{estado}` (toggle, no `/estado/` route — spot check S3) | **M only**           | envelope (works: `estado` is writable, `legacy/rassa_back/rassa/catalogos_serializers.py:50-57`) | §3.3                                  | `categoria_producto`                                 |
|                                                        | POST `/categorias/{id}/restore/`, POST `/categorias/{id}/permanent/`               | **M only**           | envelope                                                                                         | §3.3                                  | `categoria_producto`                                 |
| M: `UnitListScreen` + `UnitTrashScreen` (REAL)         | same set on `/unidades/`                                                           | B (read) / M (CRUD)  | envelope                                                                                         | §3.3                                  | `unidad` (legacy `tipo` column synced with `nombre`) |
| W: `AdminCategories`, `AdminUnits` (**HARDCODED**)     | — (zero API calls; local-state CRUD over `AdminCrudTable` sample data)             | —                    | —                                                                                                | §3.3 routes exist but unused from web | `categoria_producto`, `unidad`                       |

**Coverage: backend full · web frontend-mock-only.** The web admin screens for these two
catalogs are UI prototypes over hardcoded data (frontend-audit §3.2, §10.2); the real CRUD
contract is exercised only by the mobile app.

### 2.4 Productos + producto_imagen

| Frontend modules (status)                                                                                                     | Endpoints (method + path)                                                                                                                                                          | Used by          | Envelope                                                   | Backend family                                                             | DB entities                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| M: `ProductListScreen` (REAL), `ProductFormScreen` (REAL, 1194 lines) · W: `FarmerProducts` (REAL), `ProductFormModal` (REAL) | GET `/productos/` (filters `categoria, nombre, es_perecedero, precio_min, precio_max, unidad, ordering, page`; web adds `?page_size=200` — **ignored server-side**, spot check S5) | B                | raw DRF page (django-filter only here)                     | backend-audit §3.4 `productos_views`                                       | `producto` (+ `categoria_producto`, `unidad`)            |
|                                                                                                                               | POST `/productos/`                                                                                                                                                                 | B (farmer UI)    | **Admin-only write** (spot check S10) → mismatch, see §4.6 | §3.4                                                                       | `producto`                                               |
|                                                                                                                               | PUT `/productos/{id}/`                                                                                                                                                             | **M**            | Admin-only write → mismatch                                | §3.4                                                                       | `producto`                                               |
|                                                                                                                               | PATCH `/productos/{id}/`                                                                                                                                                           | **W**            | Admin-only write → mismatch                                | §3.4                                                                       | `producto`                                               |
|                                                                                                                               | GET `/productos/{id}/`                                                                                                                                                             | M (edit prefill) | envelope                                                   | §3.4                                                                       | `producto`                                               |
|                                                                                                                               | DELETE `/productos/{id}/`                                                                                                                                                          | B (farmer UI)    | Admin-only write → mismatch                                | §3.4                                                                       | `producto` (soft delete, no trash/restore routes)        |
| M+W image upload/delete in product form                                                                                       | POST `/productos/{id}/imagen/` (multipart; Drive)                                                                                                                                  | B                | raw serializer payload                                     | §3.4 legacy image pipeline                                                 | `producto_imagen`, legacy `producto.imagen` column       |
|                                                                                                                               | DELETE `/productos/{id}/imagen/{imageId}/`                                                                                                                                         | B                | raw                                                        | §3.4                                                                       | `producto_imagen`                                        |
|                                                                                                                               | PATCH `/productos/{id}/imagen/{imageId}/`                                                                                                                                          | M                | raw                                                        | §3.4                                                                       | `producto_imagen`                                        |
| M: `AdminProductsScreen` (**HARDCODED**) · W: `AdminProducts` (**HARDCODED**)                                                 | — (zero API calls; sample data in local state)                                                                                                                                     | —                | —                                                          | §3.4 product CRUD exists (Admin-permitted) but is exercised by no admin UI | `producto`                                               |
| M: `ProductDetailScreen` (buyer) — **STUB**                                                                                   | GET `/productos/{id}/` (route not even wired to data)                                                                                                                              | —                | —                                                          | §3.4                                                                       | `producto`                                               |
| — (no frontend caller)                                                                                                        | GET/POST `/productos/{id}/imagenes/`, DELETE/PATCH `/productos/{id}/imagenes/{imageId}/`, PATCH `.../imagenes/{imageId}/set-principal/`                                            | —                | envelope / raw                                             | §3.4 blueprint pipeline (`producto_imagen` views)                          | `producto_imagen` (Drive, `orden`, `eliminar_pendiente`) |

**Coverage: partial, with a role-level contradiction.** The farmer-facing product CRUD is
REAL-calling but targets **Admin-only** write endpoints (spot check S10) — see §4.6.
The backend's two parallel image pipelines are both live server-side; only the legacy
pipeline (`/imagen/`) has frontend callers. The newer `/imagenes/` pipeline (set-principal,
`orden`, orphan marker handling) is **backend-only**.

### 2.5 Publicaciones semanales

| Frontend modules (status)                                                                                                                          | Endpoints (method + path)                                               | Used by | Envelope              | Backend family            | DB entities                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------- | --------------------- | ------------------------- | ------------------------------------------ |
| M: `FarmerDashboardScreen` (REAL), `PublicationWizardScreen` (REAL, 5 steps) · W: `FarmerPublications` (REAL), `PublicationWizard` (REAL, 4 steps) | GET `/publicaciones/`                                                   | B       | envelope-wrapped page | backend-audit §3.5        | `publicacion_semanal`                      |
|                                                                                                                                                    | GET `/publicaciones/{id}/`                                              | B       | envelope              | §3.5                      | `publicacion_semanal`                      |
|                                                                                                                                                    | POST `/publicaciones/` (empty body → borrador)                          | B       | envelope              | §3.5                      | `publicacion_semanal`                      |
|                                                                                                                                                    | DELETE `/publicaciones/{id}/` (borrador→cancelado)                      | B       | envelope              | §3.5                      | `publicacion_semanal`                      |
|                                                                                                                                                    | POST `/publicaciones/{id}/publish/`, POST `/publicaciones/{id}/close/`  | B       | envelope              | §3.5                      | `publicacion_semanal`                      |
|                                                                                                                                                    | GET/POST `/publicaciones/{id}/productos/`                               | B       | envelope              | §3.5                      | `producto_semanal`                         |
|                                                                                                                                                    | PATCH/DELETE `/publicaciones/{id}/productos/{itemId}/`                  | B       | envelope              | §3.5                      | `producto_semanal`                         |
|                                                                                                                                                    | POST `/publicaciones/{id}/productos/{itemId}/imagen/` (multipart, 60 s) | B       | raw                   | §3.5                      | `producto_semanal.foto` (URL string)       |
| — (no frontend caller)                                                                                                                             | POST `/publicaciones/{id}/productos/{itemId}/restore/`                  | —       | envelope              | §3.5                      | `producto_semanal`                         |
| M: `CatalogScreen` (buyer, REAL — bypasses react-query) · W: `BuyerCatalog`, `BuyerHome` (REAL — bypasses react-query)                             | GET `/publicaciones/current/`                                           | B       | envelope              | §3.5 `current` (AllowAny) | `publicacion_semanal` + `producto_semanal` |

**Coverage: full** for the farmer lifecycle; one backend-only restore route. Buyer catalog
category filter is present in both UIs but applied on neither (frontend-audit §11.11).

### 2.6 Pedidos

| Frontend modules (status)                                                                       | Endpoints (method + path)                                                                                                       | Used by                          | Envelope                                                                                       | Backend family                          | DB entities                                                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| M: `CheckoutScreen` (REAL + in-flight persistence) · W: `BuyerCheckout` (REAL + checkout guard) | POST `/pedidos/` `{items:[{id_producto_semanal,cantidad}]}` + `Idempotency-Key` header (**ignored server-side**, spot check S2) | B                                | `{ok,message,data:Pedido}` via `ok_response` (mobile validates; malformed → ambiguous outcome) | backend-audit §3.6                      | `pedido_cabecera`, `detalle_pedido`, `historial_estado_pedido`, `producto_semanal` (stock) |
| M: `OrderHistoryScreen` · W: `BuyerOrders`                                                      | GET `/pedidos/`                                                                                                                 | B (role-scoped server-side)      | **raw** DRF page `{results}` (spot check S9)                                                   | §3.6                                    | `pedido_cabecera` (+ detalle)                                                              |
| M: `OrderDetailScreen` · W: `BuyerOrderDetail`                                                  | GET `/pedidos/{id}/`                                                                                                            | B                                | raw detail (`estado_actual`, `historial`)                                                      | §3.6                                    | `pedido_cabecera`, `detalle_pedido`                                                        |
| M: `SalesScreen` · W: `VendorPanelScreen`                                                       | PATCH `/pedidos/{id}/status/` `{nuevo_estado}`                                                                                  | B (seller/admin)                 | envelope                                                                                       | §3.6                                    | `pedido_cabecera`, `historial_estado_pedido`                                               |
| M: admin `OrderDetailScreen` · W: `AdminOrderDetail`                                            | GET `/pedidos/{id}/historial` (**no trailing slash** — spot check S1)                                                           | B (admin; seller limited to own) | envelope                                                                                       | §3.6                                    | `historial_estado_pedido`                                                                  |
| W: `SellerSales` (**MOCK** — hardcoded table, zero API)                                         | —                                                                                                                               | —                                | —                                                                                              | §3.6 routes exist unused from that page | —                                                                                          |
| W: `FarmerOrders` (**STUB**)                                                                    | —                                                                                                                               | —                                | —                                                                                              | —                                       | —                                                                                          |

**Coverage: full** on the five backend routes (each has ≥ 1 frontend caller); no update or
delete exists on either side. Assignment of `fk_vendedor` has no endpoint anywhere
(backend-audit §11.2).

### 2.7 Pagos

| Frontend modules (status)                                                                               | Endpoints (method + path)                                                                          | Used by          | Envelope                                          | Backend family     | DB entities                                      |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------- | ------------------ | ------------------------------------------------ |
| M: `PaymentScreen` (REAL) · W: `PaymentPage` (REAL, reconcile-first)                                    | GET `/tipos-pago/`                                                                                 | B                | **plain array** (frontend contract exception)     | backend-audit §3.7 | `tipo_pago`                                      |
|                                                                                                         | GET `/pagos/?pedido={id}` (reconcile lookup) + plain `GET /pagos/`                                 | B                | raw list                                          | §3.7               | `pago`                                           |
|                                                                                                         | POST `/pagos/` `{pedido,tipo_pago,monto,referencia?}` + `Idempotency-Key` (ignored, spot check S2) | B (seller/admin) | raw payload (`PagoOutputSerializer` recibo shape) | §3.7               | `pago` (folio), `pedido_cabecera` (auto-advance) |
| M: `ReceiptListScreen`, `ReceiptDetailScreen` · W: `BuyerReceipts`, `BuyerReceiptDetail`, `ReceiptPage` | GET `/pagos/{id}/`                                                                                 | B                | raw payload                                       | §3.7               | `pago`                                           |

**Coverage: full.** The recibo the UI shows is assembled from `Pago` — the `recibo` table
has no API at all (database-audit §8.3). Cash-only on web (`esEfectivo` auto-resolved);
mobile offers the type picker.

### 2.8 Recolecciones

| Frontend modules (status)                                                                                | Endpoints (method + path)                                                                                                  | Used by | Envelope     | Backend family      | DB entities                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------- | ------------ | ------------------- | --------------------------------------------- |
| M: `CollectionScheduleScreen` + feature components (REAL) · W: `SellerRecolecciones` + components (REAL) | GET `/recolecciones/` (filters `estado, fk_agricultor, fecha, fecha_desde, fecha_hasta`; web fetch-all with 30 s deadline) | B       | raw DRF page | backend-audit §3.13 | `recoleccion`                                 |
|                                                                                                          | POST `/recolecciones/` + `Idempotency-Key` (ignored, spot check S2)                                                        | B       | envelope     | §3.13               | `recoleccion`                                 |
|                                                                                                          | POST `/recolecciones/{id}/estado/` (strict machine)                                                                        | B       | envelope     | §3.13               | `recoleccion`, `historial_estado_recoleccion` |
|                                                                                                          | POST `/recolecciones/{id}/cancelar/` (idempotent 200)                                                                      | B       | envelope     | §3.13               | `recoleccion`, `historial_estado_recoleccion` |
| W: `useAgricultoresUbicacion`                                                                            | GET `/recolecciones/agricultores/`                                                                                         | **W**   | paginated    | §3.13               | `usuario`, `persona`, `localidad`             |
| — (no frontend caller)                                                                                   | GET `/recolecciones/{id}/`, PATCH `/recolecciones/{id}/` (edit while `pendiente`)                                          | —       | envelope     | §3.13               | `recoleccion`                                 |

**Coverage: partial.** The edit path (PATCH while pendiente) and single retrieve have no
frontend caller; both apps create + transition + cancel only. Farmer picker uses two
different data sources per app (§4.2).

### 2.9 Cortes (cash closing)

| Frontend modules (status)                                                                           | Endpoints (method + path)             | Used by | Envelope                | Backend family     | DB entities                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------- | ------- | ----------------------- | ------------------ | ------------------------------------------------ |
| M: `CashClosingScreen` (REAL) · W: `VendorCorteCaja` (REAL, tolerant list parse, optimistic create) | GET `/cortes/`                        | B       | raw list                | backend-audit §3.9 | `corte`                                          |
|                                                                                                     | GET `/cortes/teorico/?fecha=`         | B       | raw (60 s server cache) | §3.9               | `pago` (cash sum)                                |
|                                                                                                     | POST `/cortes/` `{monto_real, fecha}` | B       | raw                     | §3.9               | `corte` (snapshot `monto_teorico`, `diferencia`) |
| — (no frontend caller)                                                                              | GET `/cortes/{id}/`                   | —       | raw                     | §3.9               | `corte`                                          |

**Coverage: full** for the used trio; single-corte retrieve is backend-only.

### 2.10 Liquidaciones

| Frontend modules (status)                                                                                          | Endpoints (method + path)                                                                                    | Used by | Envelope                                                              | Backend family     | DB entities                                  |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------- | ------------------ | -------------------------------------------- |
| M: `SettlementListScreen`, `SettlementDetailScreen` (REAL) · W: `AdminSettlements`, `AdminSettlementDetail` (REAL) | GET `/liquidaciones/` (filters `agricultor, estado, periodo_inicio, periodo_fin`; safe-next multi-page walk) | B       | `{ok,data,message}` envelope (frontend `unwrapLiquidacionesEnvelope`) | backend-audit §3.8 | `liquidacion`                                |
|                                                                                                                    | GET `/liquidaciones/{id}/`                                                                                   | B       | envelope (errors also `_ok`-shaped, spot check S8)                    | §3.8               | `liquidacion` + `liquidacion_venta` snapshot |
|                                                                                                                    | POST `/liquidaciones/{id}/marcar-pagada/` `{tipo_pago, referencia?}`                                         | B       | envelope; idempotent (200 on already-paid)                            | §3.8               | `liquidacion`, `pago` (fk_pedido NULL)       |
| — (no frontend caller)                                                                                             | POST `/liquidaciones/calcular/`                                                                              | —       | envelope                                                              | §3.8               | `liquidacion`, `liquidacion_venta`           |

**Coverage: partial** — the calculation entry point (`/calcular/`) has no frontend caller;
the frontend only reads and marks paid. Admin-only on both sides.

### 2.11 Mermas (waste)

| Frontend modules (status)                                                                     | Endpoints (method + path)                                                                                    | Used by | Envelope                               | Backend family      | DB entities                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------- | -------------------------------------- | ------------------- | ----------------------------------- |
| M: `MermaResumenScreen` (REAL; manual fetch state machine) · W: `AdminMermasDashboard` (REAL) | GET `/mermas/resumen/` (`fecha_desde, fecha_hasta, producto_id, agrupar_por` — all confirmed, spot check S6) | B       | waste envelope (`unwrapWasteEnvelope`) | backend-audit §3.12 | `merma`, `decision_merma`           |
| — (no frontend caller)                                                                        | POST `/mermas/` (stock decrement under lock), GET `/mermas/`, GET `/mermas/{id}/`                            | —       | envelope                               | §3.12               | `merma`, `producto_semanal` (stock) |
| — (no frontend caller)                                                                        | GET/POST `/decisiones-merma/`, GET/PATCH/DELETE `/decisiones-merma/{id}/`                                    | —       | envelope                               | §3.12               | `decision_merma`                    |

**Coverage: partial, read-only frontend.** Merma registration (a stock-decrementing
write) and the decision catalog CRUD have no UI anywhere; the frontends only render the
aggregated resumen.

### 2.12 Familias

| Frontend modules (status)                                                                                   | Endpoints (method + path)                                                                            | Used by                              | Envelope | Backend family      | DB entities                                         |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ | -------- | ------------------- | --------------------------------------------------- |
| M: `FamilyListScreen` + trash, `FamilyDetailScreen` (REAL) · W: `AdminFamilies`, `AdminFamilyDetail` (REAL) | GET `/familias/grupos/`, GET `/familias/grupos/trash/`                                               | B                                    | envelope | backend-audit §3.10 | `familia`                                           |
|                                                                                                             | POST `/familias/grupos/`, PATCH `/familias/grupos/{id}/`, DELETE `/familias/grupos/{id}/`            | B                                    | envelope | §3.10               | `familia`, `familia_usuario` (cascade), chat (sync) |
|                                                                                                             | POST `/familias/grupos/{id}/restore/`, POST `/familias/grupos/{id}/permanent/`                       | B                                    | envelope | §3.10               | `familia`, `familia_usuario`                        |
|                                                                                                             | POST `/familias/grupos/{id}/asignar-jefe/`                                                           | B                                    | envelope | §3.10               | `familia.fk_jefe_familia`                           |
|                                                                                                             | GET `/familias/miembros/?fk_familia=`, POST `/familias/miembros/`, DELETE `/familias/miembros/{id}/` | B                                    | envelope | §3.10               | `familia_usuario`                                   |
|                                                                                                             | GET `/auth/search-users/?q=&include_assigned=`                                                       | B (head search; M `true`, W `false`) | envelope | §3.1                | `usuario`, `familia_usuario`                        |
| — (no frontend caller)                                                                                      | GET `/familias/miembros/{id}/` (single member retrieve)                                              | —                                    | envelope | §3.10               | `familia_usuario`                                   |

**Coverage: full.** Family creation is a frontend-orchestrated 3-call sequence with
rollback (see §3.3). PUT/PATCH on miembros are disabled server-side
(`familias/views.py:196` per backend-audit §3.10).

### 2.13 Chat

| Frontend modules (status)                                                                                                           | Endpoints (method + path)                                                    | Used by | Envelope                         | Backend family      | DB entities                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------- | -------------------------------- | ------------------- | --------------------------------------------- |
| 5 screens per app, all REAL, via `@rassa/chat` (`createChatApi`); 15 shared HTTP ops (frontend-audit §7.2); poll-based refresh only | GET `/chat/usuarios/conversaciones/`                                         | B       | envelope (last message + unread) | backend-audit §3.11 | `conversacion`, `integrantes`, `mensaje`      |
|                                                                                                                                     | GET `/chat/conversaciones/{id}/mensajes/?page=`                              | B       | envelope page                    | §3.11               | `mensaje`                                     |
|                                                                                                                                     | POST `/chat/mensajes/enviar/`                                                | B       | envelope                         | §3.11               | `mensaje`                                     |
|                                                                                                                                     | POST `/chat/mensajes/enviar-con-documento/` (multipart ≤ 20 MB)              | B       | envelope                         | §3.11               | `documento`, `mensaje`, `mensajes_documentos` |
|                                                                                                                                     | POST `/chat/conversaciones/crear-privada/` (idempotent 200/201)              | B       | envelope                         | §3.11               | `conversacion`, `integrantes`                 |
|                                                                                                                                     | POST `/chat/conversaciones/crear-grupal/`                                    | B       | envelope                         | §3.11               | same                                          |
|                                                                                                                                     | PATCH `/chat/conversaciones/{id}/leer/`                                      | B       | envelope                         | §3.11               | `mensaje.leido`                               |
|                                                                                                                                     | PATCH `/chat/mensajes/{id}/editar/` (15-min window)                          | B       | envelope                         | §3.11               | `mensaje` (`editado`)                         |
|                                                                                                                                     | PATCH `/chat/mensajes/{id}/inactivar/` (15-min window)                       | B       | envelope                         | §3.11               | `mensaje.estado`                              |
|                                                                                                                                     | GET `/chat/conversaciones/{id}/integrantes/`                                 | B       | envelope                         | §3.11               | `integrantes`                                 |
|                                                                                                                                     | PATCH `/chat/conversaciones/{id}/renombrar/`                                 | B       | envelope                         | §3.11               | `conversacion.nombre`                         |
|                                                                                                                                     | POST `/chat/conversaciones/{id}/agregar-integrante/`                         | B       | envelope                         | §3.11               | `integrantes`                                 |
|                                                                                                                                     | DELETE `/chat/conversaciones/{id}/integrantes/{usuarioId}/`                  | B       | envelope                         | §3.11               | `integrantes.estado`                          |
|                                                                                                                                     | PATCH `/chat/conversaciones/{id}/override-nombre/`                           | B       | envelope                         | §3.11               | `conversacion.nombre_override`                |
|                                                                                                                                     | GET `/chat/usuarios/buscar/?q=`                                              | B       | envelope                         | §3.11               | `usuario`                                     |
| — (no frontend caller)                                                                                                              | GET `/chat/conversaciones/{id}/` (conversation detail)                       | —       | envelope                         | §3.11               | `conversacion`                                |
| — (no frontend caller)                                                                                                              | POST `/chat/conversaciones/familia/{familia_id}/sincronizar/` (admin resync) | —       | envelope                         | §3.11               | `conversacion`, `integrantes`                 |

**Coverage: full** for the 15 used operations. No websockets, no push, no local chat
persistence — the only delivery mechanism is client polling (10 s → 60 s backoff for
conversations, 5 s for messages, focused-only; frontend-audit §7.3).

### 2.14 Dashboards / stats & perfil / documentos

| Frontend modules (status)                                                                                                                                                                                                                                                                                                                                                                         | Endpoints called                                                                                                                               | Backend family                                                                                   | DB entities                                    | Coverage                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| M: buyer `HomeScreen` (MOCK — `getAllProducts` from `src/services/mock/dashboard.ts`), seller `HomeSellerScreen` (MOCK — `getSellerStats`), admin `AdminPanelScreen` (MOCK stats + functional order-id lookup) · W: `AdminDashboard` (MOCK stats + lookup), `BuyerHome` (REAL catalog fetch), `SellerSales` (MOCK) · M: `FarmerHomeScreen` (REAL — counts from `/productos/` + `/publicaciones/`) | Only reused domain endpoints (`/productos/`, `/publicaciones/`, `/pedidos/{id}/historial`); **no dedicated stats endpoints exist server-side** | — (no stats family in backend-audit §3)                                                          | —                                              | **frontend-mock-only** for all stat cards; no backend counterpart ever existed |
| M: `NotificationsScreen` (**STUB**, static text) · W: absent                                                                                                                                                                                                                                                                                                                                      | none                                                                                                                                           | none (no notifications API exists)                                                               | —                                              | **stub** (M) / missing (W)                                                     |
| M: `ProfileScreen` orchestrator + edit/password components (REAL) · W: `ProfilePage` + hooks (REAL)                                                                                                                                                                                                                                                                                               | PATCH `/auth/me/`; POST `/auth/change-password/`; GET `/municipios/` + GET `/municipios/{id}/localidades/` (W picker)                          | backend-audit §3.1                                                                               | `usuario`, `persona`, `municipio`, `localidad` | **full**                                                                       |
| M+W chat attachments rendering (`mediaUrl()` over `url_documento`)                                                                                                                                                                                                                                                                                                                                | Indirect: GETs of `/documentos/...` URLs produced by `enviar-con-documento`                                                                    | §3.11 chat documents; media served from `MEDIA_ROOT` **only under DEBUG** (backend-audit §10.12) | `documento`                                    | **partial** (production serving unresolved)                                    |
| Cart (M+W, REAL client-side)                                                                                                                                                                                                                                                                                                                                                                      | none (zustand+persist `rassa-cart`; server write happens at checkout only)                                                                     | —                                                                                                | —                                              | full client-side                                                               |

---

## 3. Lifecycle data flows

### 3.1 Pedido → pago → stock → recolección → corte → liquidación

1. **Publishing (prerequisite).** The agricultor creates a weekly publication
   (`borrador`, targeting next Monday + ISO week) and fills `producto_semanal` items;
   publish requires ≥ 1 activo item with stock/price/unit/foto and is Monday-gated
   (`legacy/rassa_back/rassa/blueprints/publicacion/views.py:42-70,135-199`; rules Pu1–Pu6
   in backend-audit §5). Buyers see only `publicado` publications of the current week via
   `/publicaciones/current/` (`publicacion/views.py:327-352`).
2. **Checkout.** Buyer POSTs `/pedidos/` with cart items
   (`legacy/rassa_back/rassa/blueprints/pedido/views.py:114-194`). Server-side: items
   validated twice (serializer pre-check + re-validation under `select_for_update`),
   duplicates rejected, stock rows locked in pk order and decremented atomically
   (`pedido/views.py:336-397`; rules B2–B4), IVA 21 % and `total` recomputed on save
   (`legacy/rassa_back/rassa/models.py:442-444`), credit limit checked across the
   client's active family under lock (`pedido/views.py:442-491`; B6), state `pendiente`
   with a `HistorialEstadoPedido` row (B7–B8).
3. **State progression.** Vendedor advances the order through the linear sequence
   `pendiente→confirmado→en_preparacion→listo_para_retirar` via PATCH
   `/pedidos/{id}/status/` (`pedido/views.py:206-282`; B7); clients cannot transition (B8).
4. **Payment.** At `listo_para_retirar`, the vendedor charges: POST `/pagos/` — state
   re-checked under row lock (P1), `monto` must equal `pedido.total` (P2), exactly one
   pago per pedido (DB constraint + pre-check, P2), success auto-advances the pedido to
   `entregado` with history (P3), and the folio `REC-YYYYMMDD-###` is generated under a
   `pg_advisory_xact_lock` (`legacy/rassa_back/rassa/models.py:515-530`; P4). Both
   frontends reconcile first (`GET /pagos/?pedido=`) to avoid double payment
   (frontend-audit §3.6).
5. **Stock side-effects.** Stock was already consumed at checkout; waste registration
   (`POST /mermas/`) decrements `producto_semanal.stock` again under
   `select_for_update` with a 400 on insufficient stock (`legacy/rassa_back/rassa/blueprints/waste/views.py:127-143`;
   M1) — note this write has **no frontend UI** (§2.11).
6. **Recolección (parallel track, no FK to pedidos).** Pickups are scheduled per
   (agricultor, fecha) — `recoleccion` references only `fk_agricultor`
   (`legacy/rassa_back/rassa/models.py:806-843`); the connection to orders is implicit
   through the agriculturor's `producto_semanal` lines, not referential. Strict state
   machine and one-active-slot uniqueness are enforced server-side
   (`legacy/rassa_back/rassa/blueprints/recoleccion/views.py:40-52,315-371`; R1–R7).
7. **Corte (cash reconciliation).** The vendedor closes the day: `monto_teorico` = sum of
   that day's **efectivo** pagos, one corte per (vendedor, fecha), `monto_teorico` and
   `diferencia` are creation-time snapshots (`legacy/rassa_back/rassa/blueprints/cortes/views.py:68-125`;
   `legacy/rassa_back/rassa/models.py:584-620`; C1–C4).
8. **Liquidación (weekly settlement).** Admin-only: `entregado` pedidos containing the
   agricultor's `producto_semanal` lines are aggregated per ISO week (Monday→Sunday),
   10 % commission rounded HALF_UP, `Liquidacion` + `LiquidacionVenta` snapshots created
   atomically; any existing liquidación for the (agricultor, periodo) blocks recalculation
   with 409 (`legacy/rassa_back/rassa/blueprints/liquidaciones/views.py:47-160,193-216`;
   L1–L9). `marcar-pagada` is idempotent and creates a `Pago` with `fk_pedido=NULL`
   (`liquidaciones/views.py:491-588`; L8) — which is why `pago.fk_pedido` is nullable and
   `unique_pago_per_pedido` is `nulls_distinct=True` (database-audit §2 Pago, §7.3).

### 3.2 User / role provisioning

1. **Public self-registration** (buyer/seller only) creates `auth.User` + `Persona` +
   `Usuario` in one transaction, with `auth_user.username` set to the email
   (`legacy/rassa_back/rassa/auth_serializers.py:61-111,204-246`; cross-checks email
   uniqueness over three columns).
2. **Admin-created farmers** via POST `/auth/create-farmer/` (same serializer minus
   role; token-generation failure is non-fatal to avoid ghost users,
   `legacy/rassa_back/rassa/views.py:133-176`).
3. **Vendedores have no provisioning endpoint** — only the seed command creates them
   (backend-audit §11.1); there is also no seller-creation UI path (mobile
   `useSubmitNewUser` POSTs `/auth/register/` for non-farmer roles, which is limited to
   buyer/seller server-side).
4. **Roles are data rows** (`roles` table, seeded Admin/Vendedor/Agricultor/Cliente,
   `legacy/rassa_back/rassa/management/commands/seed_rassa_data.py:195-227`), checked via
   `Usuario.tiene_rol()` (`legacy/rassa_back/rassa/models.py:215-228`) and DRF `HasRole`
   classes (backend-audit §2.5).
5. **Deactivation** is `Usuario.estado` toggle only (`legacy/rassa_back/rassa/admin_views.py:264-319`),
   guarded by last-admin protection (U2) — but **login does not check `Usuario.estado`**
   (F-01; `legacy/rassa_back/rassa/auth_serializers.py:128-143`).
6. **Credit limits** (`LimiteCliente`) gate checkout but have no write API — seed-only
   (backend-audit §11.6).

### 3.3 Family assignment

1. Admin creates the group and assigns the head through a frontend-orchestrated
   sequence: POST `/familias/grupos/` → POST `/familias/miembros/` → POST
   `/familias/grupos/{id}/asignar-jefe/`, with DELETE rollback of the group if a later
   step fails (`legacy/rassa_front/src/services/families.ts`, web twin
   `legacy/rassa_front/web/src/services/families.ts`; frontend-audit §3.11).
2. Server-side exclusivity: a user may belong to only one **active** family — enforced
   in the serializer only, no DB constraint (`legacy/rassa_back/rassa/blueprints/familias/serializers.py:57-88`;
   database-audit §1.1.6).
3. Every family gets an idempotent group conversation with the chief as chat admin via
   the `chat_sync` service (`legacy/rassa_back/rassa/blueprints/chat/services/chat_sync.py:31-157`;
   F4); family chat name follows the family name unless `nombre_override`
   (F5, signals at `legacy/rassa_back/rassa/blueprints/chat/signals.py:11-27`).
4. Soft delete deactivates memberships and archives the chat; restore requires a new
   chief (`legacy/rassa_back/rassa/blueprints/familias/views.py:38-144`; F2–F3). Hard
   delete removes member rows first, then archives chat (§3.10).
5. Head search reuses `/auth/search-users/` with different `include_assigned` values per
   app (M `true`, W `false` — frontend-audit §3.11).

### 3.4 Product publishing + images (Google Drive)

1. Catalog `producto` CRUD is Admin-permitted server-side (spot check S10); the farmer
   UIs call it anyway (mismatch — §4.6).
2. Weekly `producto_semanal` items reference catalog products; the publication wizard
   creates the draft, adds items, persists with orphan deletion, then publishes
   (web orchestration in `legacy/rassa_front/web/src/utils/persistItems.ts` +
   `legacy/rassa_front/web/src/utils/runPersist.ts`; frontend-audit §3.4).
3. Item images upload as multipart to `/publicaciones/{id}/productos/{itemId}/imagen/`
   (URL string stored in `producto_semanal.foto`); product images upload to Drive via
   two parallel pipelines (backend-audit §10.3):
   - legacy `/productos/{id}/imagen/`: private-then-`make_public` after commit, always
     sets principal, syncs legacy `producto.imagen`, 5 MB cap
     (`legacy/rassa_back/rassa/productos_views.py:213-289`).
   - blueprint `/imagenes/`: public immediately, `orden` support, 10 MB cap
     (`legacy/rassa_back/rassa/blueprints/producto_imagen/views.py`) — **no frontend
     callers**.
4. Principal-image uniqueness is a DB partial unique plus transactional demote/promote
   (`legacy/rassa_back/rassa/models.py:791-800`; G3). Agricultor ownership: only
   products they have published (`legacy/rassa_back/rassa/permissions/ownership.py:12-43`; G1).
5. Deletion state machine: Drive delete failure leaves the row with
   `eliminar_pendiente=True`, hidden from lists, retried by the manual
   `cleanup_orphan_drive_files` command (G4; `legacy/rassa_back/rassa/management/commands/cleanup_orphan_drive_files.py:1-79`);
   the legacy delete path hard-deletes the row even when the Drive delete failed
   (backend-audit §10.3) — the two paths disagree on failure semantics.

### 3.5 Chat conversation lifecycle

1. Private conversations are get-or-create (200 existing / 201 created) via
   `/chat/conversaciones/crear-privada/` (`legacy/rassa_back/rassa/blueprints/chat/views.py:265-300`; Ch1).
2. Groups: creator becomes chat `integrantes.rol="admin"`; family-linked conversations
   cannot be created manually (sync service owns them — §3.3).
3. Messages: send text or multipart document (≤ 20 MB, extension whitelist, MIME sniffed
   with python-magic when importable; stored under `media/documentos/`
   `legacy/rassa_back/rassa/blueprints/chat/serializers.py:51-99`, Ch4).
4. Edit/soft-delete are owner-only within a 15-minute window (Ch2,
   `legacy/rassa_back/rassa/blueprints/chat/views.py:157-238`); read-marking is a bulk
   update excluding own messages (Ch3).
5. Delivery is **polling only** — both apps refetch conversations every 10 s (backoff to
   60 s) and messages every 5 s, only while focused; nothing persists chat locally
   (frontend-audit §7.3). The backend has no ASGI/websocket runtime at all
   (backend-audit §1).
6. Membership changes are soft; family conversations are managed exclusively by
   `chat_sync` (rename/membership blocked for family chats — F5).

### 3.6 Checkout + idempotency

1. **Mobile** (`legacy/rassa_front/src/screens/common/CheckoutScreen.tsx` +
   `legacy/rassa_front/src/services/checkoutPersistence.ts`): computes IVA locally
   (0.21), generates an idempotency key, persists an in-flight record (`rassa-checkout-in-flight`)
   **before** POST `/pedidos/`; on ambiguous failure (timeout/network without response,
   or `InvalidOrderEnvelopeError`) reconciles against GET `/pedidos/` by total + products
   - 60 s recency window; mount-time reconciliation replays any persisted in-flight
     record (frontend-audit §6.1).
2. **Web** (`legacy/rassa_front/web/src/services/checkoutGuard.ts`, 419 lines): pre-write
   ambiguous marker in both storages; cross-tab in-flight lock (TTL 60 s); fingerprint-
   stable idempotency key (`rassa-checkout-idempotency`); payload re-validation
   (`clampOrderItems`); axios-retry disabled per-request for the POST; ambiguous-outcome
   detection + re-confirmation banner + late-success surfacing
   (`rassa-checkout-placed`) (frontend-audit §6.3).
3. **Server side: the `Idempotency-Key` header is never read** (spot check S2). Every
   duplicate-protection guarantee above is therefore client-side only; the real backend
   protections are the stock locks, the credit-limit lock, and transaction atomicity.
4. **Payment idempotency** (`idem_pago_{orderId}` persisted per order in both apps) has
   **no cleanup path** in either app — one entry accumulates per paid order forever
   (frontend-audit §6.2, §6.4; spot-checked `PaymentScreen.tsx:47-54`).
5. Recibo/LimiteCliente sit outside this loop: no write APIs exist for either
   (backend-audit §11.5–11.6).

---

## 4. Correspondence findings

### 4.1 Matches (high confidence)

- **Pedidos**: all 5 backend routes have frontend callers; verbs match
  (PATCH `/pedidos/{id}/status/` on both apps).
- **Pagos**: all 4 routes used; the `/tipos-pago/` plain-array exception is a deliberate
  frontend contract (`legacy/rassa_back/rassa/blueprints/pagos/views.py:208-213`).
- **Publicaciones farmer lifecycle**: complete correspondence including the
  create→items→publish→close chain; buyer `current` endpoint used by both apps.
- **Familias**: full correspondence (11 of 12 routes; the single retrieve is inert).
- **Chat**: 15 of 17 routes used; both apps share one API module (`@rassa/chat`), so
  verb drift is impossible there.
- **Municipios/localidades**: full lifecycle correspondence on both apps, including
  trash/restore/permanent and the `/estado/` toggle (used by BOTH apps — spot check S3
  corrects frontend-audit §4.1, which marked the toggle W-only).
- **Auth**: all 8 auth operations used by both apps; register role split
  (buyer public / farmer admin) matches the backend's role restriction
  (`legacy/rassa_back/rassa/auth_serializers.py:210`).

### 4.2 Verb and convention mismatches

| Anomaly                                                                                                                                                      | Evidence                                                                                                                                                                                              | Status                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Product update: mobile `PUT` vs web `PATCH` on `/productos/{id}/`                                                                                            | `legacy/rassa_front/src/services/productos.ts` (`updateProducto` → `api.put`), frontend-audit §3.3/§10.3; backend accepts both (backend-audit §3.4)                                                   | CONFIRMED (cosmetic for this backend; a strict-tRPC rewrite must pick one)            |
| Mobile toggle for categorías/unidades PATCHes the detail route with `{estado}`; municipios/localidades PATCH `/{id}/estado/` — web only ever uses `/estado/` | spot check S3 (`CrudListScreen.tsx:566-580` + screen configs)                                                                                                                                         | CONFIRMED (both shapes work server-side)                                              |
| Localidades parent scoping: `?municipio_id=` (M) vs `/municipios/{id}/localidades/` (W)                                                                      | spot check S4; frontend-audit §3.2                                                                                                                                                                    | CONFIRMED (both supported)                                                            |
| Farmer picker in recolecciones: `/admin/usuarios/?rol=Agricultor&estado=true` (M) vs `/recolecciones/agricultores/` (W)                                      | frontend-audit §3.7                                                                                                                                                                                   | CONFIRMED (two data sources for one picker)                                           |
| Wizard step counts: 5 (M) vs 4 (W) for the same publication flow                                                                                             | frontend-audit §3.4/§10.3                                                                                                                                                                             | CONFIRMED (parallel implementations)                                                  |
| `GET /pedidos/{id}/historial` without trailing slash (single call site per app)                                                                              | `legacy/rassa_front/src/hooks/useOrderTimeline.ts:26`, `legacy/rassa_front/web/src/routes/AdminOrderDetail.tsx:31` (frontend-audit §4.4); route has slash, `CommonMiddleware` present — spot check S1 | CONFIRMED anomaly; tolerance via append-slash redirect is an INFERENCE (not executed) |
| Chat verbs: mobile exploration report claimed POST for editar/inactivar/leer/renombrar; shared source uses PATCH                                             | frontend-audit §7.2 note                                                                                                                                                                              | RESOLVED in favor of PATCH (source of truth is `chatApi.ts`)                          |

### 4.3 Envelope inconsistencies (per-endpoint, no global contract)

| Pattern                                               | Endpoints                                                                                                           | Evidence                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `{ok,data,message}` envelope                          | most resources (auth, catalogs, familias, chat, publicaciones, mermas writes, recolecciones writes, admin usuarios) | backend-audit §3 (`_ok()`/`OkResponseMixin`, `legacy/rassa_back/rassa/views.py:43-98`) |
| Raw DRF page `{count,next,previous,results}`          | **GET `/pedidos/`** (spot check S9)                                                                                 | `legacy/rassa_back/rassa/blueprints/pedido/views.py:63`                                |
| Raw detail body                                       | GET `/pedidos/{id}/`, pagos list/detail/create, cortes (all), producto image routes                                 | frontend-audit §4.2; backend-audit §3.7/§3.9                                           |
| Plain array                                           | GET `/tipos-pago/`                                                                                                  | `legacy/rassa_back/rassa/blueprints/pagos/views.py:208-213`                            |
| Envelope on **error statuses** (`ok:false` + message) | liquidaciones (400/404/409/500 all `_ok`-shaped; 409 transient carries `Retry-After`)                               | spot check S8; `legacy/rassa_back/rassa/views.py:43-49`                                |
| Waste-specific envelope                               | GET `/mermas/resumen/`                                                                                              | frontend-audit §4.2 (`unwrapWasteEnvelope`)                                            |
| Dual-unwrap tolerance in clients                      | `{ok,data}` vs `{results,next}` (mobile pagination walker); `parseApiList` on cortes                                | frontend-audit §4.2, §3.8                                                              |

Consequence: envelope handling must be mapped per endpoint, not globally. The frontend's
claim that liquidación errors arrive `ok:true` on 400/409 is contradicted by current
backend code (spot check S8) — flagged, not resolved (see `audit-findings.md` §4).

### 4.4 Backend endpoints with NO frontend usage

- `GET /api/auth/health/` (backend-audit §3.1)
- `GET /api/logs/`, `GET /api/logs/{id}/` — the whole audit-log API (§3.1)
- `GET /api/admin/usuarios/{id}/` (§3.1)
- New image pipeline: `GET|POST /api/productos/{id}/imagenes/`, `DELETE|PATCH .../imagenes/{image_id}/`, `PATCH .../imagenes/{image_id}/set-principal/` (§3.4)
- `POST /api/publicaciones/{id}/productos/{itemId}/restore/` (§3.5)
- `GET /api/recolecciones/{id}/`, `PATCH /api/recolecciones/{id}/` — the recolección edit path (§3.13)
- `GET /api/cortes/{id}/` (§3.9)
- `POST /api/liquidaciones/calcular/` — settlements are created server-side with no UI trigger (§3.8)
- Merma writes: `POST /api/mermas/`, `GET /api/mermas/`, `GET /api/mermas/{id}/`, and the full `decisiones-merma` CRUD (§3.12)
- `GET /api/familias/miembros/{id}/` (§3.10)
- `GET /api/chat/conversaciones/{id}/`, `POST /api/chat/conversaciones/familia/{familia_id}/sincronizar/` (§3.11)

(Spot check S7 removes `GET /localidades/trash/` from this list — mobile uses it.)

### 4.5 Frontend calls with no (or contrary) backend evidence

| Call                                                                         | Evidence                                                                                                                 | Flag                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `Idempotency-Key` header on POST `/pedidos/`, `/pagos/`, `/recolecciones/`   | frontend-audit §6/§4.1; backend grep empty (spot check S2)                                                               | **Ignored server-side** — the client-side machinery is the only protection |
| `GET /productos/?page_size=200` (web wizard picker)                          | frontend-audit §4.1; spot check S5                                                                                       | **Param ignored** (default page size 20 applies)                           |
| Farmer product create/update/delete (`POST/PUT/DELETE /productos/...`)       | frontend farmer screens are REAL-calling (frontend-audit §3.3); backend writes are `IsAdminOrReadOnly` (spot check S10)  | **Role mismatch** — agricultor writes should 403; see below                |
| Web settlements comment: "business errors arrive as ok:true on HTTP 400/409" | `legacy/rassa_front/web/src/services/settlements.ts:184-185` vs `legacy/rassa_back/rassa/views.py:43-49` (spot check S8) | **Comment contradicted by backend code** (envelope is `ok:false` on ≥400)  |
| Vite `/documentos` proxy + chat attachment URLs                              | frontend-audit §11.4; backend serves media only under DEBUG (backend-audit §10.12)                                       | Production serving unresolved                                              |
| Web `AdminCategories`/`AdminUnits`/`AdminProducts` (hardcoded)               | frontend-audit §3.2/§3.3                                                                                                 | Frontend-mock-only; backend CRUD exists but is exercised by no admin UI    |

**The farmer-product mismatch, stated exactly:** the mobile `ProductListScreen` /
`ProductFormScreen` and web `FarmerProducts` / `ProductFormModal` issue
`POST/PUT/PATCH/DELETE` against `/productos/`, and are marked REAL in the frontend
audit; the backend gates those writes with `IsAdminOrReadOnly`
(`legacy/rassa_back/rassa/productos_views.py:57,95,223`), whose semantics are
"writes for Admin" (backend-audit §2.5, `legacy/rassa_back/rassa/permissions/role_permissions.py:100-115`).
The backend audit's role summary for Agricultor likewise grants no product-write rights.
Static evidence therefore indicates farmer writes to the product catalog would be
rejected (Inference — 403 not executed). Either the deployed backend differs from this
checkout, or the farmer product screens never worked against it; **which of the two is
true cannot be decided from the repo**.

### 4.6 Incomplete features (state of evidence only)

- **Admin product/category/unit CRUD** — mocked in the web app and hardcoded in the
  mobile admin screen; backend routes exist for productos (Admin-permitted) and for
  categorías/unidades, but no admin UI exercises them. Whether the backend CRUD "works"
  is supported only by the backend audit's serializer/view evidence + test inventory —
  not by any frontend integration (frontend-audit §10.2; backend-audit §3.3/§3.4).
- **Stub screens**: mobile `ProductDetailScreen` (buyer), mobile `NotificationsScreen`;
  web `FarmerOrders`. Web has no notifications surface at all (frontend-audit §10.2).
- **Mocked dashboards**: buyer/seller/admin stat cards on mobile, admin dashboard and
  seller sales on web — no stats endpoints exist server-side (frontend-audit §3.16).
- **Recibo**: table + folio exist; no API writes or reads `recibo` — the receipt UI
  renders `Pago` output (database-audit §8.3; backend-audit §11.5).
- **LimiteCliente**: gates checkout (B6) but has no write API — seed-only
  (backend-audit §11.6).
- **Vendedor provisioning/assignment**: no endpoint writes `usuario.fk_rol=Vendedor`
  (public register allows buyer/seller, but no admin seller-creation route exists) and
  no endpoint writes `pedido_cabecera.fk_vendedor` (backend-audit §11.1–11.2). How
  vendedores get assigned to orders is undocumented in the repo.
- **Merma registration**: backend flow complete (stock decrement, pedido binding);
  zero frontend callers — waste is registered outside the apps or not at all (§2.11).
- **Buyer catalog category filter**: UI present in both apps, applied on neither
  (frontend-audit §11.11).

### 4.7 Role model conflict

| Vocabulary                 | Where                                                                                              | Values                                                                                                            | Evidence                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Backend (data-driven)      | `roles` table + serializers                                                                        | `Admin, Vendedor, Agricultor, Cliente` (Spanish strings); frontend-facing aliases map `buyer/farmer/seller/admin` | `legacy/rassa_back/rassa/management/commands/seed_rassa_data.py:195-227`, `legacy/rassa_back/rassa/auth_serializers.py:24-36` |
| Mobile canonical (English) | `AuthContext` ROLE_MAP                                                                             | `farmer, seller, admin, buyer` — Spanish backend strings normalized **to English**; unknown role throws           | `legacy/rassa_front/src/store/AuthContext.tsx` (frontend-audit §10.4)                                                         |
| Web canonical (Spanish)    | `normalizeRole`                                                                                    | `agricultor, vendedor, admin, cliente` — English normalized **to Spanish**; default `cliente`                     | `legacy/rassa_front/web/src/types/index.ts` (frontend-audit §10.4)                                                            |
| Web duplicate User types   | `web/src/types/index.ts` (field `rol`) vs `web/src/components/admin-users/types.ts` (field `role`) | structurally similar, distinct types                                                                              | frontend-audit §10.4                                                                                                          |

Consequence for any rewrite: four vocabularies (DB values, backend aliases, mobile
canonical, web canonical) describe the same four roles, plus per-call-site
`id_usuario`/`id` mappers. This is a naming decision the new app must make explicitly —
not derivable from any single source.

---

## 5. Feature completeness assessment

Legend per cell: **real** (live API end-to-end) · **partial** (real but reduced scope) ·
**mocked** (fake data) · **stub** (placeholder) · **dead** (unreachable code) ·
**absent** (no surface). Evidence refs are abbreviated (FA = frontend-audit, BA =
backend-audit).

| Domain                                  | Mobile                                                                                                                        | Web                                                       | Notes / evidence                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Auth & session                          | real                                                                                                                          | real                                                      | FA §3.1                                   |
| Admin user management                   | real                                                                                                                          | real                                                      | FA §3.13                                  |
| Municipios / localidades                | real                                                                                                                          | real                                                      | FA §3.2; spot checks S3/S4/S7             |
| Categorías / unidades                   | real (M CRUD)                                                                                                                 | **mocked** (hardcoded)                                    | FA §3.2/§10.2                             |
| Product catalog (farmer CRUD)           | real-calling / **role-mismatched**                                                                                            | real-calling / **role-mismatched**                        | spot check S10; §4.5 above                |
| Product images (legacy pipeline)        | real                                                                                                                          | real                                                      | FA §3.3                                   |
| Product images (blueprint `/imagenes/`) | absent                                                                                                                        | absent                                                    | backend-only (BA §3.4)                    |
| Buyer product detail                    | **stub**                                                                                                                      | absent                                                    | FA §10.2                                  |
| Publicaciones (farmer lifecycle)        | real                                                                                                                          | real                                                      | FA §3.4 (5-step vs 4-step wizard)         |
| Buyer catalog                           | real (react-query bypassed)                                                                                                   | real (react-query bypassed)                               | FA §3.4/§5.3; category filter not applied |
| Cart                                    | real (client-only)                                                                                                            | real (client-only)                                        | FA §3.15                                  |
| Checkout (buyer)                        | real + in-flight persistence                                                                                                  | real + checkout guard                                     | FA §6                                     |
| Pedidos (buyer list/detail)             | real                                                                                                                          | real                                                      | FA §3.5                                   |
| Pedidos (seller list/status)            | real                                                                                                                          | real                                                      | FA §3.5                                   |
| Pedidos (seller "Ventas" page)          | real (SalesScreen)                                                                                                            | **mocked** (SellerSales)                                  | FA §3.5                                   |
| Pedidos (farmer orders)                 | absent                                                                                                                        | **stub**                                                  | FA §3.5                                   |
| Pedidos (admin detail/timeline)         | real (via lookup)                                                                                                             | real (via lookup)                                         | FA §3.5; no sidebar link                  |
| Pagos + recibos                         | real                                                                                                                          | real                                                      | FA §3.6                                   |
| Recolecciones                           | real                                                                                                                          | real (extra: create-private-chat shortcut)                | FA §3.7; PATCH edit path unused (§4.4)    |
| Cortes                                  | real                                                                                                                          | real                                                      | FA §3.8                                   |
| Liquidaciones                           | real (admin)                                                                                                                  | real (admin)                                              | FA §3.9; `/calcular/` unused (§4.4)       |
| Mermas                                  | partial (resumen only)                                                                                                        | partial (resumen only)                                    | §2.11; writes backend-only                |
| Familias                                | real (admin)                                                                                                                  | real (admin)                                              | FA §3.11                                  |
| Chat                                    | real (polling)                                                                                                                | real (polling)                                            | FA §7                                     |
| Dashboards/stats                        | **mocked** (buyer/seller/admin)                                                                                               | **mocked** (admin) / real (buyer home fetch, farmer home) | FA §3.16                                  |
| Notifications                           | **stub**                                                                                                                      | absent                                                    | FA §3.16/§10.2                            |
| Perfil / password                       | real                                                                                                                          | real                                                      | FA §3.14                                  |
| Offline behavior                        | UI-only (NetInfo banners block submits)                                                                                       | UI-only (`useOnline` on one screen; no SW/PWA)            | FA §8.2                                   |
| Dead code                               | AdminDashboardScreen, AdminUsersScreen, unused mock exports, empty `src/components/ui/`, `@rassa/api`, `@rassa/design-tokens` | `routes/admin.tsx` samples, `@root` alias                 | FA §9/§10.1                               |

---

## Next step

`audit-findings.md` consolidates the confirmed findings (F-01…F-nn), the inferences
register, cross-source contradictions, the deduplicated open-question register, and the
offline-first needs classification (analysis only) derived from the usage patterns
mapped here.
