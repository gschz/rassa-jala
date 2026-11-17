# RassaJala Legacy Frontend Audit — `legacy/rassa_front`

Technical audit of the legacy frontend monorepo: the Expo/React Native mobile app (root `src/`), the Vite/React 19 web app (`web/`), and four shared packages. This document inventories every functional module, screen, form, operation, filter, and API touchpoint observed in frontend code, and flags what is real versus mocked, dead, or stubbed. It is a behavioral spec input for the RassaJala rewrite — backend claims are NOT verified here (see the separate backend audit).

**Scope & method.** Base material: three exploration reports (mobile app, web app part 1 + part 2) plus targeted read-only spot checks of specific files to resolve flagged uncertainties (IVA rate, chat HTTP methods, product update verb, payment idempotency persistence, `/documentos` references, trailing-slash anomaly). Every path cited below is repo-relative and exists in the tree at audit time. Nothing under `legacy/**` was modified.

**Labels.** Coverage: **[B]** both apps · **[M]** mobile-only · **[W]** web-only. Data status: **REAL** (live API calls) · **MOCK** (fake data module) · **HARDCODED** (fake data inline, no API) · **STUB** (placeholder screen) · **DEAD** (unreachable code). Every claim is CONFIRMED by file evidence unless explicitly marked _Inference_.

---

## 1. Overview

### 1.1 Monorepo layout

```
legacy/rassa_front/
├── index.js, App.tsx, app.json, package.json   # Expo mobile app (root)
├── src/            # mobile app source (~45 screens, services, stores, hooks, features)
├── web/            # Vite/React 19 web app ("rassa-web")
└── packages/
    ├── api/             # @rassa/api   — axios client factory (DEAD, see §9)
    ├── chat/            # @rassa/chat  — chat domain core + API factory (used by both)
    ├── common/          # @rassa/common — shared domain services/helpers (used by both)
    └── design-tokens/   # @rassa/design-tokens — tokens (DEAD, see §9)
```

The mobile `package.json` declares `workspaces: ["web"]` — the only workspace link; packages are consumed via tsconfig path aliases, not npm workspaces (`legacy/rassa_front/tsconfig.json`: `@/*`, `~/*` → `src/`, `@/common/*` → `packages/common/src/`, `@rassa/chat` → `packages/chat/src/`; web `vite.config.ts`: `@/common` → `../packages/common/src`, `@`/`~` → `./src`, `@rassa/chat` → `../packages/chat/src`, plus an unused `@root` alias).

### 1.2 Stack

| Concern       | Mobile (root `package.json`)                                                                                      | Web (`web/package.json`)                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Runtime       | Expo SDK 54, React Native 0.81.5, React 19.1.0                                                                    | React 19.1 + react-dom 19.1                                                      |
| Bundler/build | Metro (expo, dev port 8082; Expo web metro 8083)                                                                  | Vite 6 (dev port 5173), `build = tsc -b && vite build`                           |
| Language      | TypeScript (flat ESLint config `config/eslint.config.ts`, boundaries plugin)                                      | TypeScript 5.6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Routing       | `@react-navigation` native-stack + bottom-tabs ^7.0.0                                                             | react-router-dom ^7                                                              |
| Server state  | @tanstack/react-query ^5                                                                                          | @tanstack/react-query ^5                                                         |
| Client state  | zustand ^5.0.14 (cart only)                                                                                       | zustand ^5.0.14 (cart only)                                                      |
| HTTP          | axios ^1.15.1 + axios-retry ^4.5.0                                                                                | axios ^1.15.1 + axios-retry ^4.5.0                                               |
| UI            | react-native-paper ^5.12 (MD3) + nativewind ^4 / tailwindcss ^3.4                                                 | Tailwind ^3.4 + pervasive inline style objects + lucide-react ^0.400             |
| Observability | @sentry/react-native ~7.2 (gated on `EXPO_PUBLIC_SENTRY_DSN`)                                                     | @sentry/react ^10.12 (gated on `VITE_SENTRY_DSN`)                                |
| Storage       | expo-secure-store ~15 + @react-native-async-storage/async-storage ^2                                              | localStorage / sessionStorage                                                    |
| Connectivity  | @react-native-community/netinfo ~11.4                                                                             | `navigator.onLine` via `useOnline`                                               |
| Tests         | jest-expo, @testing-library/react-native (~100 test files in `src/__tests__/`)                                    | vitest 4 + jsdom + RTL + MSW ^2.15 (79 test files; MSW test-only)                |
| Other         | expo-image-picker/document-picker/file-system/audio/video(-thumbnails)/sharing, reanimated 4, keyboard-controller | —                                                                                |

Environment variables (names only; no values are committed): `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SENTRY_DSN` (mobile); `VITE_API_URL`, `VITE_SENTRY_DSN` (web).

### 1.3 Entry points

- **Mobile**: `legacy/rassa_front/index.js` registers `legacy/rassa_front/App.tsx`, which wires providers in order: QueryClientProvider (retry 1, exponential backoff capped 30s, staleTime 30s, QueryCache onError → log) → ThemeProvider → PaperProvider (MD3, brand colors from `legacy/rassa_front/src/constants/colors.ts`) → AuthProvider → ErrorBoundary → KeyboardProvider → NavigationContainer → AppNavigator + StatusBar.
- **Web**: `legacy/rassa_front/web/index.html` (CSP meta + inline pre-paint theme script) → `legacy/rassa_front/web/src/main.tsx`: StrictMode → ErrorBoundary → QueryProvider → ThemeProvider → AuthProvider → App (BrowserRouter). Sentry `beforeSend` strips `authorization`/`cookie` headers; breadcrumbs redact token params.

App identity (`legacy/rassa_front/app.json`): name "Rassa", slug `rassa`, version 1.0.0, portrait, light UI, brand green `#16a34a`, bundle id `com.rassa.app` (iOS + Android), plugins `expo-audio` + `expo-video`.

**Mobile layer rule** (AGENTS.md, enforced by eslint-plugin-boundaries): screens → features → components → hooks → services → api.

---

## 2. Navigation & routing

### 2.1 Mobile — 8 navigators, ~70 route registrations, ~45 screens

Single source of truth: `legacy/rassa_front/src/navigation/AppNavigator.tsx` (693 lines). Root gating:

1. `isLoading`/onboarding check → SplashScreen; onboarding completion persisted under `onboarding_completed` (**native only** — skipped on Expo web); a 5s splash timeout falls back to `legacy/rassa_front/src/navigation/RoleErrorScreen.tsx` with logout.
2. `!isAuthenticated` → AuthStack.
3. `switch (user?.role)`: `farmer | seller | admin | buyer` → role navigator; undefined/unknown → RoleErrorScreen (deny-by-default; role strings are normalized to this English vocabulary by AuthContext — see §10.4).

| Navigator   | Type            | Registered routes                                                                                                                                                                                                                                              |
| ----------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AuthStack   | native stack    | Login, Register                                                                                                                                                                                                                                                |
| BuyerTabs   | bottom tabs     | Home, Pedidos (OrderHistoryScreen), Catalog, Carrito, Notificaciones (hidden tab button), ChatList                                                                                                                                                             |
| BuyerStack  | stack           | BuyerTabs + OrderDetail, Checkout, OrderSuccess, ProductDetail, ReceiptList, ReceiptDetail, Profile, Chat, GroupDetail                                                                                                                                         |
| FarmerStack | stack (no tabs) | FarmerHome, ProductList, ProductForm (transparent modal), FarmerDashboard, PublicationWizard (fullScreenModal), Profile, ChatList, Chat, GroupDetail, CreateGroup, StartChat                                                                                   |
| SellerTabs  | bottom tabs     | HomeSeller, Sales, Recolecciones (CollectionScheduleScreen), Notificaciones (hidden), Perfil (ProfileSellerScreen, hidden), ChatList                                                                                                                           |
| SellerStack | stack           | SellerTabs + CashClosing, Payment, Receipt, Chat, GroupDetail, CreateGroup, StartChat                                                                                                                                                                          |
| AdminTabs   | bottom tabs     | AdminInicio (AdminPanelScreen), AdminProducts, CategoryList, UnitList, MunicipioList, UserManagement, FamilyList, ChatList                                                                                                                                     |
| AdminStack  | stack           | AdminPanel, AdminProfile, UserForm, FamilyDetail, FamilyForm, Chat, GroupDetail, CreateGroup, StartChat, CategoryTrash, UnitTrash, MunicipioTrash, LocalidadList, LocalidadTrash, OrderDetail (admin), Profile, MermaResumen, SettlementList, SettlementDetail |

Guards: the root role switch is the only navigation guard, with two exceptions — `UserFormScreen` performs its own admin-role verification (GET `/auth/me/` + admin allowlist) and the ChatList "new chat" FAB is hidden for buyers (`role !== 'buyer'`).

**Dead (CONFIRMED)**: `legacy/rassa_front/src/screens/admin/AdminDashboardScreen.tsx` and `legacy/rassa_front/src/screens/admin/AdminUsersScreen.tsx` are never imported by the navigator or any screen; the registered admin entry is AdminPanelScreen.

### 2.2 Web — 40 route entries + 5 chat routes × 4 role trees

Router: `legacy/rassa_front/web/src/routes/index.tsx` (230 lines) inside BrowserRouter. Guards: `legacy/rassa_front/web/src/components/guards/ProtectedRoute.tsx` (isAuthenticated + optional role; wrong role → that role's dashboard; unauthenticated → `/login` carrying `state.from`) and `legacy/rassa_front/web/src/components/guards/AdminRoute.tsx` (admin only, else `/`). RootRedirect at `/`: admin→`/admin`, agricultor→`/agricultor/productos`, vendedor→`/vendedor/ventas`, cliente→`/cliente`, else `/login` (web canonical role vocabulary is Spanish — see §10.4).

| Prefix        | Path                          | Component                                                   | File                                                          |
| ------------- | ----------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| public        | `/login`                      | LoginScreen                                                 | `legacy/rassa_front/web/src/routes/Login.tsx`                 |
| public        | `/register`                   | RegisterScreen                                              | `legacy/rassa_front/web/src/routes/Register.tsx`              |
| public        | `/`                           | RootRedirect (inline)                                       | `legacy/rassa_front/web/src/routes/index.tsx`                 |
| `/agricultor` | `productos`                   | FarmerProducts                                              | `legacy/rassa_front/web/src/routes/farmer.tsx`                |
| `/agricultor` | `pedidos`                     | FarmerOrders — **STUB** (empty placeholder)                 | same file                                                     |
| `/agricultor` | `publicaciones`               | FarmerPublications                                          | `legacy/rassa_front/web/src/routes/FarmerPublications.tsx`    |
| `/agricultor` | `publicaciones/nueva`         | PublicationWizard                                           | `legacy/rassa_front/web/src/routes/PublicationWizard.tsx`     |
| `/agricultor` | `publicaciones/:id/editar`    | PublicationWizard                                           | same file                                                     |
| `/agricultor` | `perfil`                      | ProfilePage                                                 | `legacy/rassa_front/web/src/routes/ProfilePage.tsx`           |
| `/vendedor`   | `ventas`                      | SellerSales — **MOCK**                                      | `legacy/rassa_front/web/src/routes/seller.tsx`                |
| `/vendedor`   | `pedidos`                     | VendorPanelScreen                                           | `legacy/rassa_front/web/src/routes/VendorPanelScreen.tsx`     |
| `/vendedor`   | `recolecciones`               | SellerRecolecciones                                         | `legacy/rassa_front/web/src/routes/SellerRecolecciones.tsx`   |
| `/vendedor`   | `corte-caja`                  | VendorCorteCaja                                             | `legacy/rassa_front/web/src/routes/VendorCorteCaja.tsx`       |
| `/vendedor`   | `cobrar/:orderId`             | PaymentPage                                                 | `legacy/rassa_front/web/src/routes/PaymentPage.tsx`           |
| `/vendedor`   | `recibo/:paymentId`           | ReceiptPage                                                 | `legacy/rassa_front/web/src/routes/ReceiptPage.tsx`           |
| `/vendedor`   | `perfil`                      | ProfilePage                                                 | `legacy/rassa_front/web/src/routes/ProfilePage.tsx`           |
| `/admin`      | (index)                       | AdminDashboard — **MOCK stats**, functional order-id lookup | `legacy/rassa_front/web/src/routes/AdminDashboard.tsx`        |
| `/admin`      | `productos`                   | AdminProducts — **HARDCODED CRUD**                          | `legacy/rassa_front/web/src/routes/AdminProducts.tsx`         |
| `/admin`      | `categorias`                  | AdminCategories — **HARDCODED CRUD**                        | `legacy/rassa_front/web/src/routes/AdminCategories.tsx`       |
| `/admin`      | `unidades`                    | AdminUnits — **HARDCODED CRUD**                             | `legacy/rassa_front/web/src/routes/AdminUnits.tsx`            |
| `/admin`      | `familias`                    | AdminFamilies — REAL                                        | `legacy/rassa_front/web/src/routes/AdminFamilies.tsx`         |
| `/admin`      | `familias/detalle?familyId=N` | AdminFamilyDetail (id via `useSearchParams`)                | `legacy/rassa_front/web/src/routes/AdminFamilyDetail.tsx`     |
| `/admin`      | `perfil`                      | ProfilePage                                                 | `legacy/rassa_front/web/src/routes/ProfilePage.tsx`           |
| `/admin`      | `municipios`                  | AdminMunicipios — REAL                                      | `legacy/rassa_front/web/src/routes/AdminMunicipios.tsx`       |
| `/admin`      | `localidades`                 | AdminLocalidades — REAL                                     | `legacy/rassa_front/web/src/routes/AdminLocalidades.tsx`      |
| `/admin`      | `usuarios`                    | AdminUsers — REAL                                           | `legacy/rassa_front/web/src/routes/AdminUsers.tsx`            |
| `/admin`      | `mermas`                      | AdminMermasDashboard — REAL                                 | `legacy/rassa_front/web/src/routes/AdminMermasDashboard.tsx`  |
| `/admin`      | `liquidaciones`               | AdminSettlements — REAL                                     | `legacy/rassa_front/web/src/routes/AdminSettlements.tsx`      |
| `/admin`      | `liquidaciones/:id`           | AdminSettlementDetail — REAL                                | `legacy/rassa_front/web/src/routes/AdminSettlementDetail.tsx` |
| `/admin`      | `pedidos/:id`                 | AdminOrderDetail — REAL                                     | `legacy/rassa_front/web/src/routes/AdminOrderDetail.tsx`      |
| `/cliente`    | (index)                       | BuyerHome                                                   | `legacy/rassa_front/web/src/routes/BuyerHome.tsx`             |
| `/cliente`    | `catalogo`                    | BuyerCatalog                                                | `legacy/rassa_front/web/src/routes/BuyerCatalog.tsx`          |
| `/cliente`    | `carrito`                     | BuyerCart                                                   | `legacy/rassa_front/web/src/routes/BuyerCart.tsx`             |
| `/cliente`    | `checkout`                    | BuyerCheckout                                               | `legacy/rassa_front/web/src/routes/BuyerCheckout.tsx`         |
| `/cliente`    | `pedidos`                     | BuyerOrders                                                 | `legacy/rassa_front/web/src/routes/BuyerOrders.tsx`           |
| `/cliente`    | `pedidos/:id`                 | BuyerOrderDetail                                            | `legacy/rassa_front/web/src/routes/BuyerOrderDetail.tsx`      |
| `/cliente`    | `recibos`                     | BuyerReceipts                                               | `legacy/rassa_front/web/src/routes/BuyerReceipts.tsx`         |
| `/cliente`    | `recibos/:paymentId`          | BuyerReceiptDetail                                          | `legacy/rassa_front/web/src/routes/BuyerReceiptDetail.tsx`    |
| `/cliente`    | `perfil`                      | ProfilePage                                                 | `legacy/rassa_front/web/src/routes/ProfilePage.tsx`           |
| *             | 404                           | NotFound (inline)                                           | `legacy/rassa_front/web/src/routes/index.tsx`                 |

**Chat routes**: `CHAT_ROUTE_CONFIGS` mounts 5 shared routes in EACH of the 4 role trees (`agricultor`, `vendedor`, `admin`, `cliente`), files under `legacy/rassa_front/web/src/routes/chat/`: `chat` (ChatListPage), `chat/nuevo` (StartChatPage), `chat/nuevo/grupo` (CreateGroupPage), `chat/:id` (ChatDetailPage), `chat/:id/grupo` (GroupDetailPage). Unknown subpaths redirect to the tree's home. Totals: 40 explicit entries + 20 chat registrations = 60; ~39 distinct page components.

Sidebar (`legacy/rassa_front/web/src/components/layout/Sidebar.tsx`, `roleNavMap`; also accepts legacy English `"farmer"`): admin → Panel, Productos, Categorías, Unidades, Familias, Municipios, Localidades, Mermas, Liquidaciones, Usuarios, Chat, Perfil; agricultor → Productos, Publicaciones, Pedidos, Chat, Mi Perfil; vendedor → Ventas, Pedidos, Recolecciones, Corte de caja, Chat, Mi Perfil; cliente → Inicio, Catálogo, Carrito, Pedidos, Mis Recibos, Chat, Mi Perfil. Notable: **no sidebar link to admin orders** (AdminOrderDetail is reached only via the AdminDashboard order-id lookup) and **no links to Payment/Receipt** (action-reached).

**Dead (CONFIRMED)**: `legacy/rassa_front/web/src/routes/admin.tsx` contains sample AdminUsers/AdminProducts/AdminOrders components that are NOT imported by the router (the real `AdminUsers.tsx`/`AdminProducts.tsx` are used).

---

## 3. Functional module inventory

The core section. For each domain: screens/pages, forms (fields + validation), operations, filters, data consumed, navigation relationships, and per-app coverage + data status.

### 3.1 Auth & session [B] — REAL

| Aspect                       | Mobile                                                                                                                                                       | Web                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screens                      | `legacy/rassa_front/src/screens/auth/LoginScreen.tsx` (673 lines), `RegisterScreen.tsx`; Splash + Onboarding [M]                                             | `legacy/rassa_front/web/src/routes/Login.tsx`, `Register.tsx`                                                                                                                                                                                                                      |
| Login form                   | email + password local state; client-side required-field validation; submit → AuthContext.login                                                              | email + password; `EMAIL_REGEX` + password ≥ 8; POST `/token/` then GET `/auth/me/` with explicit Authorization header; `mapMeUser` (`id_usuario`→`id`, `rol                                                                                                                       | role`→normalized)                      |
| Login post-conditions        | tokens persisted via storage facade; session restore on mount (token → `/auth/me/`; network error → 1 retry with 1–2s jitter; 401 → clearSession)            | writes localStorage `token` + `user` `{id,email,rol}`, sessionStorage `refresh_token`; role redirect: admin→`/admin/usuarios`, vendedor→`/vendedor/ventas`, agricultor→`/agricultor/productos`, cliente→`/cliente`; cross-tab logout sync via `storage` event                      |
| Register form (shared shape) | `RegistrationFormFields` + `useRegistrationForm` (13-field form state; validation delegated to `validateRegistrationForm` in `@rassa/common` at submit time) | fields: nombre*, apellidoPaterno*, apellidoMaterno (opt), email*, password* (≥8), telefono* (`formatPhoneNumber`), fechaNacimiento* (custom `WebDatePickerModal`), sexo* (M/F/O), domicilio*, municipio* + localidad* (catalog pickers); field cleaners `cleanName`/`cleanAddress` |
| Register semantics           | POST `/auth/register/` (auto-login inside context); NetInfo-gated submit; double-submit guard via ref                                                        | buyer-only self-registration: payload role hardcoded `'buyer'` via `buildRegistrationPayload`; POST `/auth/register/` → `{data:{access,refresh,…user}}` → login + role redirect                                                                                                    |
| Admin-created users          | `UserFormScreen` / `UserManagementScreen` via `useSubmitNewUser`: POST `/auth/create-farmer/` when role=farmer, else POST `/auth/register/`                  | same split in `legacy/rassa_front/web/src/components/admin-users/NuevoUsuarioForm.tsx` (role selector farmer/seller/buyer; shared `validateRegistrationForm`)                                                                                                                      |
| Password change              | ChangePassword component: POST `/auth/change-password/` via context; validated by shared `validatePasswordChange`; **force logout after success**            | `usePasswordChange`: POST `/auth/change-password/` `{old_password,new_password}`; rules ≥8, alphanumeric only (no specials), ≥1 uppercase, confirm match                                                                                                                           |
| Profile edit                 | ProfileEditForm → `AuthContext.updateProfile` → PATCH `/auth/me/` (NetInfo gate)                                                                             | PATCH `/auth/me/` `{nombre, apellido_paterno, apellido_materno                                                                                                                                                                                                                     | null, telefono, fecha_nacimiento, sexo | null, domicilio, fk_localidad | null}`; catalogs via GET `/municipios/`+ GET`/municipios/{id}/localidades/` |

Navigation relationships: Login/Register are the only public destinations on both apps; everything else requires the root role gate (mobile) or ProtectedRoute (web). Mobile-only extras: SplashScreen, OnboardingScreen (multi-slide; native-only persistence).

### 3.2 Catalogs — municipios / localidades / categorías / unidades

| Entity      | Mobile                                                                                                                                             | Web                                                   | Status                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| Municipios  | MunicipioListScreen + MunicipioTrashScreen (thin configs over shared `CrudListScreen` / `TrashListScreen` in `legacy/rassa_front/src/components/`) | `AdminMunicipios.tsx` (842 lines)                     | **[M] REAL · [W] REAL**      |
| Localidades | LocalidadListScreen (scoped by `municipio_id` route param) + LocalidadTrashScreen                                                                  | `AdminLocalidades.tsx` (1014 lines) + parent dropdown | **[M] REAL · [W] REAL**      |
| Categorías  | CategoryListScreen + CategoryTrashScreen                                                                                                           | `AdminCategories.tsx`                                 | **[M] REAL · [W] HARDCODED** |
| Unidades    | UnitListScreen + UnitTrashScreen                                                                                                                   | `AdminUnits.tsx`                                      | **[M] REAL · [W] HARDCODED** |

- Mobile generic CRUD (`CrudListScreen`, 1421 lines): list GET with query params, create POST, edit PATCH, delete DELETE, toggle active (POST to a toggle endpoint or base — exact toggle URL not pinned in exploration), client-side search, NetInfo offline banner, dialogs, toasts. Trash screens: GET trash view (`estado=false`), restore POST `{endpoint}{id}/restore/`, permanent POST `{endpoint}{id}/permanent/`.
- Web municipios/localidades implement the full soft-delete lifecycle: list + `/trash/` tabs, POST create, PATCH edit, DELETE soft, POST restore, POST permanent, **plus PATCH `/{id}/estado/ {estado}`** (a toggle mechanism the mobile app does not use) and web-only GET `/municipios/{id}/localidades/` (profile location selector).
- Web AdminCategories/AdminUnits (and AdminProducts, §3.3) render `legacy/rassa_front/web/src/components/admin/AdminCrudTable.tsx` with hardcoded initial data — categories: Hortalizas/Frutas/Cereales/Legumbres; units: Kilogramo/Unidad/Litro/Libra — with create/edit/delete entirely on local `useState`. No fetch, no api import, no persistence.
- Consumers: registration forms (municipio + localidad), product forms (categorías + unidades, both apps), publication wizard (unidades), farmer location grouping (web `useAgricultoresUbicacion`).

Parent-scoping inconsistency: mobile reads localidades via GET `/localidades/?municipio_id={id}`; web profile uses GET `/municipios/{id}/localidades/`. Two conventions for the same relationship.

### 3.3 Productos

| Aspect                      | Mobile                                                                                                                                                                                                                                                                                                              | Web                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Farmer list                 | `legacy/rassa_front/src/screens/farmer/ProductListScreen.tsx` (903 lines): GET `/productos/` with filters, DELETE `/productos/{id}/`, NetInfo banner; search + category filter (client/server mix)                                                                                                                  | `legacy/rassa_front/web/src/routes/farmer.tsx`: react-query `['farmer-productos',search,cat]`, 400ms debounced search, desktop table + mobile cards, delete with optimistic update + rollback                               |
| Farmer form                 | `legacy/rassa_front/src/screens/farmer/ProductFormScreen.tsx` (1194 lines, transparent modal): GET `/categorias/`, `/unidades/`; POST / **PUT** `/productos/{id}/`; image upload POST `/productos/{id}/imagen/` (multipart, 60s timeout, expo-image-picker); **PATCH + DELETE** `/productos/{id}/imagen/{imageId}/` | `ProductFormModal` (component): POST create / **PATCH** `/productos/{id}/`; image upload POST `.../imagen/` multipart with 2-attempt backoff retry (`productImageUpload.ts`); DELETE `.../imagen/{imageId}/`                |
| List filter params observed | GET `/productos/` supports `categoria, nombre, es_perecedero, precio_min, precio_max, unidad, ordering, page` (service-layer surface in `legacy/rassa_front/src/services/productos.ts`; UI uses a subset)                                                                                                           | `?nombre=&categoria=` (+ `?page_size=200` for the wizard's product picker)                                                                                                                                                  |
| Admin                       | `legacy/rassa_front/src/screens/admin/AdminProductsScreen.tsx` (747 lines): **HARDCODED** — `initialProducts` (5 fake products), local CRUD/toggle/trash UI, zero API calls. UI prototype.                                                                                                                          | `AdminProducts.tsx`: **HARDCODED** local-state CRUD via AdminCrudTable (Aguacate Hass, Tomate orgánico, Café especial, Cebolla larga — Mexican-flavored sample data inconsistent with the Jalisco-oriented rest of the app) |
| Buyer detail                | `legacy/rassa_front/src/screens/buyer/ProductDetailScreen.tsx`: **STUB** ("Próximamente…" placeholder; takes `farmerId` param, renders nothing real)                                                                                                                                                                | none (catalog cards only)                                                                                                                                                                                                   |

Update-verb inconsistency: mobile edits products with **PUT** `/productos/{id}/` (`legacy/rassa_front/src/services/productos.ts`, `updateProducto` → `api.put`), web with **PATCH** `/productos/{id}/`. Mobile-only operations: GET `/productos/{id}/`, PUT `/productos/{id}/`, PATCH `/productos/{id}/imagen/{imageId}/`.

### 3.4 Publicaciones (weekly catalog) — [B] REAL

| Aspect          | Mobile                                                                                                                                                                                                                                                                                                                        | Web                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Management list | `legacy/rassa_front/src/screens/farmer/FarmerDashboardScreen.tsx` (508 lines): tabs by publication `estado` via `usePublicaciones(estado)`; publish / close / delete lifecycle                                                                                                                                                | `legacy/rassa_front/web/src/routes/FarmerPublications.tsx` (599 lines): tabs all/borrador/publicado/cerrado; client filters month/year/minProducts; client pagination (PAGE_SIZE 10); publish/close/delete with ConfirmDialog + detail modal; date helpers (`isMondayToday` etc.)                                                                                                                                                                                                                                                                                                                                        |
| Wizard          | `legacy/rassa_front/src/screens/farmer/PublicationWizardScreen.tsx` (457 lines, fullScreenModal): **5 steps** (fecha → productos → resumen → publicar + ProductPickerModal) driven by `usePublicationWizard`; guard: publish blocked if an item's product no longer exists                                                    | `legacy/rassa_front/web/src/routes/PublicationWizard.tsx` (741 lines): **4 steps**; create mode makes draft POST `/publicaciones/` then adds items; edit mode loads publication + items + catalog; persistence orchestrated by `legacy/rassa_front/web/src/utils/persistItems.ts` (upsert → snapshot refresh → delete orphans) + `legacy/rassa_front/web/src/utils/runPersist.ts` (300s timeout, AbortController, savingRef guard, publish-after-persist helper); temp IDs mapped to server IDs; 5MB image cap (jpeg/png/webp/gif), 60s upload timeout; `beforeunload` guard while unsaved; blob URLs revoked on unmount |
| Buyer catalog   | `legacy/rassa_front/src/screens/buyer/CatalogScreen.tsx` (243 lines): GET `/publicaciones/current/` + `/categorias/` on mount (plain useState/useEffect — **not** react-query); flat grid, client-side search; category filter UI present but **NOT applied** (code comment: backend lacks `id_categoria` on weekly products) | `legacy/rassa_front/web/src/routes/BuyerCatalog.tsx`: same fetches in parallel via useEffect (**bypasses react-query**); client search + category chips; add-to-cart stock-capped; "Sin stock" disabled at 0                                                                                                                                                                                                                                                                                                                                                                                                             |
| Buyer home      | HomeScreen: **MOCK** stats only (see §3.16)                                                                                                                                                                                                                                                                                   | `legacy/rassa_front/web/src/routes/BuyerHome.tsx`: REAL GET `/publicaciones/current/` via useEffect (bypasses react-query; **load failure silently ignored**); first 6 in-stock featured products + cart count + quick links                                                                                                                                                                                                                                                                                                                                                                                             |

Operations (identical set on both): GET `/publicaciones/`, GET/DELETE `/publicaciones/{id}/`, POST `/publicaciones/` (empty body → borrador), POST `/{id}/publish/`, POST `/{id}/close/`, GET/POST `/{id}/productos/`, PATCH/DELETE `/{id}/productos/{itemId}/`, POST `/{id}/productos/{itemId}/imagen/` (multipart, 60s), GET `/publicaciones/current/`. All ids pass `assertValidId` (web `legacy/rassa_front/web/src/constants/api.ts`).

### 3.5 Pedidos (orders)

| Role               | Mobile                                                                                                                                                                                                         | Web                                                                                                                                                                                                                                                                                                     | Status   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Buyer list         | `legacy/rassa_front/src/screens/buyer/OrderHistoryScreen.tsx`: GET `/pedidos/` (results list), pull-to-refresh, nav to detail + receipts                                                                       | `legacy/rassa_front/web/src/routes/BuyerOrders.tsx`: GET `/pedidos/` raw `{results}`, key `['pedidos-cliente']`, DataTable (#, joined productos with `has_more_productos`, total, estado, expirado)                                                                                                     | [B] REAL |
| Buyer detail       | `legacy/rassa_front/src/screens/buyer/OrderDetailScreen.tsx` (494 lines): GET `/pedidos/{orderId}/`, items + totals + historial timeline                                                                       | `legacy/rassa_front/web/src/routes/BuyerOrderDetail.tsx`: raw OrderDetail (`estado_actual`, `historial[]`, `expirado`, `fecha_expiracion`); status timeline; `isOrderExpired` from `@/common/orders`                                                                                                    | [B] REAL |
| Buyer creation     | CheckoutScreen (§6)                                                                                                                                                                                            | BuyerCheckout (§6)                                                                                                                                                                                                                                                                                      | [B] REAL |
| Seller list/status | `legacy/rassa_front/src/screens/seller/SalesScreen.tsx` (644 lines): GET `/pedidos/?estado={filter}`, PATCH `/pedidos/{pedidoId}/status/ {nuevo_estado}`, cancel (estado `'cancelado'`), nav Payment + Receipt | `legacy/rassa_front/web/src/routes/VendorPanelScreen.tsx`: GET `/pedidos/?estado=`, status flow pendiente→confirmado→en_preparacion→listo_para_retirar→entregado (+cancelado), per-row pending set; "Cobrar" enabled at `listo_para_retirar`, checks `fetchPagoPorPedido` first to avoid double payment | [B] REAL |
| Seller sales page  | — (SalesScreen is the real list)                                                                                                                                                                               | `legacy/rassa_front/web/src/routes/seller.tsx` SellerSales: **MOCK** — hardcoded `sampleSales` DataTable, decorative "Nueva venta" button, zero API calls                                                                                                                                               | [W] MOCK |
| Farmer orders      | **absent** (not registered for farmer)                                                                                                                                                                         | `legacy/rassa_front/web/src/routes/farmer.tsx` FarmerOrders: **STUB** — empty-state placeholder ("Para el futuro equipo que le toque esta parte")                                                                                                                                                       | [W] STUB |
| Admin order detail | `legacy/rassa_front/src/screens/admin/OrderDetailScreen.tsx` (77 lines): wraps shared OrderTimeline → GET `/pedidos/{orderId}/historial`; reached from AdminPanel order-id lookup                              | `legacy/rassa_front/web/src/routes/AdminOrderDetail.tsx`: GET `/pedidos/{id}/historial` (see trailing-slash anomaly, §4.4); reached only from AdminDashboard lookup                                                                                                                                     | [B] REAL |

_Inference (labeled)_: seller/admin order lists are scoped server-side to the requesting role — GET `/pedidos/` is called with no user/seller parameter on both apps yet serves as the seller's sales list. Backend scoping to be confirmed by the backend audit.

### 3.6 Pagos (payments) — [B] REAL

| Aspect         | Mobile                                                                                                                                                                                                                                                                                                                                                          | Web                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buyer receipts | `legacy/rassa_front/src/screens/buyer/ReceiptListScreen.tsx` (`fetchPagos` from `@rassa/common`) + `ReceiptDetailScreen.tsx` (`fetchPago`, `esPropietarioPago` ownership check, subtotals via `calcularSubtotal`/`calcularImporte`)                                                                                                                             | `legacy/rassa_front/web/src/routes/BuyerReceipts.tsx` (fetchPagos + client-side `esPropietarioPago` filter as IDOR defense-in-depth) + `BuyerReceiptDetail.tsx` (adds `esPagoIdValido` guard; folio/pedido/fecha/cliente/metodo/referencia/monto + productos)                                                                                                                                                                                                                                                                                                                                                                                       |
| Seller payment | `legacy/rassa_front/src/screens/seller/PaymentScreen.tsx` (612 lines): GET `/pedidos/{orderId}/` + `fetchPagoPorPedido`; `createPago` POST `/pagos/` payload per `tipo_pago` with Idempotency-Key; existing-payment recovery path; idempotency key persisted under `idem_pago_{orderId}` via the storage facade (spot-checked: `PaymentScreen.tsx` lines 47–54) | `legacy/rassa_front/web/src/routes/PaymentPage.tsx`: order must be `estado_actual === ORDER_STATUS_READY`; GET `/tipos-pago/` (staleTime Infinity); cash-only (`esEfectivo` resolved automatically, no picker UI); optional `referencia` (max 200 chars); **reconcile-first** GET `/pagos/?pedido={id}` → reuse existing pago, else POST `/pagos/` `{pedido, tipo_pago, monto: order.total, referencia?}` with Idempotency-Key persisted in localStorage `idem_pago_{orderId}`; on error reconciles again before showing the error; synchronous `paymentInFlight` ref guards double-click; success invalidates `['pedidos']` + `['pedido',orderId]` |
| Seller receipt | `legacy/rassa_front/src/screens/seller/ReceiptScreen.tsx` (`fetchPago`)                                                                                                                                                                                                                                                                                         | `legacy/rassa_front/web/src/routes/ReceiptPage.tsx` (folio, productos table, subtotal, resumen)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Navigation: seller order list → Payment (`cobrar`) → Receipt, on both apps. Buyer: orders → receipts list → receipt detail.

### 3.7 Recolecciones (collections) — [B] REAL

| Aspect                       | Mobile                                                                                                                                                                                                                                                   | Web                                                                                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen                       | `legacy/rassa_front/src/screens/seller/CollectionScheduleScreen.tsx` (481 lines) + feature components in `legacy/rassa_front/src/features/recolecciones/` (RecoleccionCard, FilterChips, AgricultorSelector, ScheduleRecoleccionModal, constants, utils) | `legacy/rassa_front/web/src/routes/SellerRecolecciones.tsx` (325 lines) + `legacy/rassa_front/web/src/components/recolecciones/` (same component names)                                                                                                                     |
| List & filters               | GET `/recolecciones/` with `estado, fk_agricultor, fecha, fecha_desde, fecha_hasta` (multi-page walk)                                                                                                                                                    | GET `/recolecciones/?estado=&fecha_desde=today` (today resets at local midnight via self-rescheduling timer); separate fetch-all query (30s deadline) enabled **only while the schedule modal is open**, used for duplicate detection, truncation banner                    |
| Create                       | ScheduleRecoleccionModal: farmer + date; POST `/recolecciones/` with Idempotency-Key (`crypto.randomUUID`); duplicate guard `recoleccionDuplicateKey(agricultor, fecha)`                                                                                 | ScheduleRecoleccionModal: agricultor + fecha (`WebDatePickerModal`) + `hora_inicio`/`hora_fin` + `comentarios`; POST with Idempotency-Key; client validation `esRecoleccionDuplicada` + `isValidFecha` + no-past-date (`legacy/rassa_front/web/src/utils/recolecciones.ts`) |
| Transitions                  | `cambiarEstadoRecoleccion` POST `/recolecciones/{id}/estado/`; `cancelarRecoleccion` POST `/recolecciones/{id}/cancelar/`                                                                                                                                | same endpoints; state machine `TRANSICIONES` in `legacy/rassa_front/web/src/constants/recolecciones.ts`; ConfirmDialog on cancel; optimistic toast then background refetch with degradation toast                                                                           |
| Farmer source for the picker | `useFarmers` → GET `/admin/usuarios/?rol=Agricultor&estado=true`                                                                                                                                                                                         | `useAgricultoresUbicacion` → GET `/recolecciones/agricultores/` (paginated fetch-all, grouped by ubicación) — **different data source per app for the same picker**                                                                                                         |
| Extras                       | —                                                                                                                                                                                                                                                        | "Contactar" per card → `useCreatePrivateConversation` (POST `/chat/conversaciones/crear-privada/`) → navigate to that role's chat detail                                                                                                                                    |

### 3.8 Cortes (cash closing) — [B] REAL, seller-only

- Mobile `legacy/rassa_front/src/screens/seller/CashClosingScreen.tsx` (548 lines): GET `/cortes/`, GET `/cortes/teorico/?fecha=today`, POST `/cortes/ {monto_real, fecha}`; NetInfo gate.
- Web `legacy/rassa_front/web/src/routes/VendorCorteCaja.tsx`: same endpoints; list parsed tolerantly (`parseApiList` accepts `{results}` or array); optimistic `cancelQueries` + snapshot rollback on create; positive-float validation; shows teórico vs real diferencia and estado abierto/cerrado/cuadrado; `useOnline` offline banner.

### 3.9 Liquidaciones (settlements) — [B] REAL, admin-only

- List: mobile `legacy/rassa_front/src/screens/admin/SettlementListScreen.tsx` (506 lines) / web `legacy/rassa_front/web/src/routes/AdminSettlements.tsx` (328 lines). GET `/liquidaciones/` with filters `agricultor, estado, periodo_inicio, periodo_fin`; multi-page walk with **safe-next-URL guard** (rejects cross-origin/protocol-relative next links to prevent JWT leakage — web `legacy/rassa_front/web/src/services/settlements.ts` lines 80–91, tagged CONV-2) and `SETTLEMENTS_MAX_PAGES` cap from `@rassa/common/settlements`; explicit truncation banner. Farmers filter: GET `/admin/usuarios/?rol=Agricultor&estado=true` (web variant is all-or-nothing — throws if truncated; mobile strips PII into `FarmerOption`).
- Detail: `legacy/rassa_front/src/screens/admin/SettlementDetailScreen.tsx` (379) / `legacy/rassa_front/web/src/routes/AdminSettlementDetail.tsx`. GET `/liquidaciones/{id}/`; mark paid via POST `/liquidaciones/{id}/marcar-pagada/ {tipo_pago, referencia?}` through `PagarModal`; endpoint is idempotent (already-paid → 200 + message). **Business errors can arrive as `ok:true` on HTTP 400/409** — callers branch on HTTP status, never on `envelope.ok` (R4/R5 code comments). Optimistic `setQueryData` on success (web).
- Shared machinery in `legacy/rassa_front/packages/common/src/settlements.ts` (envelope unwrap, URL builder, page cap).

### 3.10 Mermas (waste) — [B] REAL, admin-only

- Single endpoint GET `/mermas/resumen/` with `fecha_desde, fecha_hasta, producto_id, agrupar_por` (URL builder `buildResumenUrl` + `unwrapWasteEnvelope` in `legacy/rassa_front/packages/common/src/waste.ts`).
- Mobile `legacy/rassa_front/src/screens/admin/MermaResumenScreen.tsx` (563 lines): **manual fetch state machine, not react-query**; decision palette donar / tirar / compostar.
- Web `legacy/rassa_front/web/src/routes/AdminMermasDashboard.tsx` (748 lines): react-query key `['merma-resumen',…filters]`; ranking bars, period trend, detail table with decision colors from the shared waste module; own class-component error boundary.

### 3.11 Familias (families) — [B] REAL, admin-only

- List + trash: mobile `legacy/rassa_front/src/screens/families/FamilyListScreen.tsx` (961 lines) / web `legacy/rassa_front/web/src/routes/AdminFamilies.tsx` (1412 lines). GET `/familias/grupos/` + GET `/familias/grupos/trash/`; soft delete DELETE `/familias/grupos/{id}/`; restore POST `/{id}/restore/`; permanent POST `/{id}/permanent/`.
- Create with head: `createFamilyWithHead` (mobile `legacy/rassa_front/src/services/families.ts`; web `legacy/rassa_front/web/src/services/families.ts`): POST `/familias/grupos/ {nombre_familia, detalle_familia?, estado:true}` → POST `/familias/miembros/ {fk_usuario, fk_familia}` → POST `/familias/grupos/{id}/asignar-jefe/ {fk_jefe_familia}`, with rollback DELETE of the group if member/assign steps fail, and a hard error if the rollback itself fails. Edit via PATCH.
- Detail: `FamilyDetailScreen.tsx` (1084 lines) / `AdminFamilyDetail.tsx`: GET `/familias/grupos/{id}/` + GET `/familias/miembros/?fk_familia={id}`; add member POST `/familias/miembros/`; remove member DELETE `/familias/miembros/{id_familia_usuario}/`; assign head POST `/familias/grupos/{id}/asignar-jefe/`.
- Head search: GET `/auth/search-users/?q=` — mobile passes `include_assigned=true`; web `legacy/rassa_front/web/src/hooks/useJefeSearch.ts` uses `include_assigned=false` (enabled at ≥1 char).

### 3.12 Chat — [B] REAL (full detail in §7)

Five screens per app (list, conversation, create group, group detail, start chat); 15 shared HTTP operations through `@rassa/chat`; poll-based refresh, no websockets, no local persistence beyond the react-query cache.

### 3.13 Usuarios / admin user management — [B] REAL

- Mobile `legacy/rassa_front/src/screens/admin/UserManagementScreen.tsx` (969 lines): `fetchAllPages('/admin/usuarios/')` (multi-page walk, cap 20); create user via `useSubmitNewUser` (`legacy/rassa_front/src/hooks/useSubmitNewUser.ts`: `validateRegistrationForm` → `buildRegistrationPayload` → POST `/auth/create-farmer/` (farmer) or `/auth/register/` (other roles); invalidates `['admin-users']`); toggle estado PATCH `/admin/usuarios/{id}/toggle-estado/`; role change PATCH `/admin/usuarios/{id}/ {role}`; search/filter client-side; dedicated dialogs (`components/UserManagement/*`).
- Web `legacy/rassa_front/web/src/routes/AdminUsers.tsx` (463 lines): same endpoints, recursive pagination walk (MAX_PAGES 20; unwraps `{data:{results,next}}` or raw; keeps partial results on page error), keys `['admin-users']` + `['current-user']`; tabs lista/nuevo; self-deactivation prevented via `currentUserId`; `RoleChangeModal` + `DeactivationModal`; create via `NuevoUsuarioForm`.
- Mobile-only extra: `UserFormScreen.tsx` (271 lines) with its own admin-role verification.

### 3.14 Perfil — [B] REAL

- Mobile: orchestrator `legacy/rassa_front/src/screens/common/profile/ProfileScreen.tsx` (156 lines) + ProfileView / ProfileEditForm / ChangePassword components; edit goes through AuthContext (PATCH `/auth/me/`); NetInfo gates; password change forces logout.
- Web: `legacy/rassa_front/web/src/routes/ProfilePage.tsx` → ProfileComponent + `components/profile/hooks.ts` (`useProfileState` with AbortController; field list in §3.1; `useUbicacionesCatalog`; `usePasswordChange`).
- Admin profile re-exports the shared screen (mobile `legacy/rassa_front/src/screens/admin/AdminProfileScreen.tsx`; `legacy/rassa_front/src/screens/seller/ProfileSellerScreen.tsx` is a 3-line re-export).

### 3.15 Carrito — [B] REAL client-side, no API

- Store: zustand + persist in both apps (mobile AsyncStorage key `rassa-cart`, `legacy/rassa_front/src/store/cartStore.ts`; web localStorage key `rassa-cart`, `legacy/rassa_front/web/src/store/cartStore.ts` with a **manual `storage`-event listener → `persist.rehydrate()`** because zustand v5 persist does not listen to storage events).
- `CartItem {id_producto_semanal, producto, unidad, precio, foto, agricultor, cantidad, stock}`; `addItem` clamps to stock; `updateQuantity` clamps (0 removes); `removeItem`; `clearCart`; `total()`.
- UI: mobile `legacy/rassa_front/src/screens/common/CarritoScreen.tsx` (quantity clamp, remove, clear with Alert confirm, total, nav to Checkout); web `legacy/rassa_front/web/src/routes/BuyerCart.tsx` (same operations; nav to checkout).

### 3.16 Dashboard / stats — mostly FAKE

| Surface         | Mobile                                                                                                                                                                                                                                               | Web                                                                                                                                                                                         | Status                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Buyer home      | `legacy/rassa_front/src/screens/buyer/HomeScreen.tsx`: stat cards from `getAllProducts()` in `legacy/rassa_front/src/services/mock/dashboard.ts` (file comment: "replace with API calls when backend endpoints exist")                               | REAL catalog fetch (but bypasses react-query, §5.4)                                                                                                                                         | [M] MOCK · [W] REAL               |
| Seller home     | `legacy/rassa_front/src/screens/seller/HomeSellerScreen.tsx`: `getSellerStats()` (salesToday/Week/Month, pendingDeliveries, pendingCollections) + CorteCard                                                                                          | SellerSales page is a mock table (§3.5)                                                                                                                                                     | [M] MOCK · [W] MOCK               |
| Admin dashboard | `legacy/rassa_front/src/screens/admin/AdminPanelScreen.tsx` (386 lines): `getAdminStats()` (totalProducts/Users/Orders/Farmers/Sellers/revenue) + **functional order-id lookup** → admin OrderDetail; quick links to MermaResumen and SettlementList | `legacy/rassa_front/web/src/routes/AdminDashboard.tsx` (532 lines): hardcoded stats, week sales, recent activity + functional order-id lookup (safe-int validation) → `/admin/pedidos/{id}` | [B] MOCK stats, functional lookup |
| Farmer home     | `legacy/rassa_front/src/screens/farmer/FarmerHomeScreen.tsx` (141 lines): REAL counts via `useFarmerHomeStats` (GET `/productos/` + GET `/publicaciones/`) + quick actions + FarmerDrawer                                                            | — (farmer lands on `productos`)                                                                                                                                                             | [M] REAL                          |
| Notifications   | `legacy/rassa_front/src/screens/common/NotificationsScreen.tsx` (18 lines): **STUB** — static "No tienes notificaciones por el momento."                                                                                                             | **absent** (no route, no page)                                                                                                                                                              | [M] STUB                          |

Unused mock exports (DEAD, grep-verified): `getFarmerStats`, `getFarmerProducts`, `getRecentSales` in `legacy/rassa_front/src/services/mock/dashboard.ts`.

---

## 4. API usage map

All HTTP traffic goes through one axios instance per app (`legacy/rassa_front/src/services/api.ts`, `legacy/rassa_front/web/src/services/api.ts`), plus the shared `@rassa/chat` factory wrapping the same instance. Counts observed from frontend code: **web = 94 endpoint operations (~85 distinct URL paths); mobile ≈ 60 distinct endpoint pairs; consolidated inventory = 106 operations across ~90 distinct URL paths** (mobile-only CRUD on categorías/unidades and product detail/update add to the web set). Purpose below is inferred from call-site usage; server behavior is out of scope for this document.

### 4.1 Consolidated inventory

Marks: **B** used by both apps · **M** mobile-only usage · **W** web-only usage.

**Auth & session (8, all B)**

| Method + path                                  | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| POST `/token/`                                 | login → `{access, refresh}`                                 |
| POST `/token/refresh/`                         | refresh flow (interceptor)                                  |
| GET `/auth/me/`                                | session restore, login, profile, admin self-check           |
| PATCH `/auth/me/`                              | profile update                                              |
| POST `/auth/register/`                         | buyer self-registration + admin-created non-farmer users    |
| POST `/auth/create-farmer/`                    | admin-created farmer users                                  |
| POST `/auth/change-password/`                  | password change (force logout on mobile)                    |
| GET `/auth/search-users/?q=&include_assigned=` | family head / chat user search (`true` mobile, `false` web) |

**Admin users (3, all B)**

| Method + path                               | Purpose                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| GET `/admin/usuarios/`                      | paginated walk (20 pages); variant `?rol=Agricultor&estado=true` for farmer pickers |
| PATCH `/admin/usuarios/{id}/`               | role change `{role}`                                                                |
| PATCH `/admin/usuarios/{id}/toggle-estado/` | activate/deactivate                                                                 |

**Products & base catalogs (11)**

| Method + path                              | Used by | Purpose                                                                                                                                       |
| ------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/productos/`                          | B       | farmer list + wizard picker (`?page_size=200` web); params `categoria, nombre, es_perecedero, precio_min, precio_max, unidad, ordering, page` |
| POST `/productos/`                         | B       | create                                                                                                                                        |
| GET `/productos/{id}/`                     | M       | detail for edit form                                                                                                                          |
| PUT `/productos/{id}/`                     | M       | update (**web uses PATCH instead**)                                                                                                           |
| PATCH `/productos/{id}/`                   | W       | update                                                                                                                                        |
| DELETE `/productos/{id}/`                  | B       | delete (web: optimistic + rollback)                                                                                                           |
| POST `/productos/{id}/imagen/`             | B       | multipart image upload (60s timeout; web adds 2-attempt retry)                                                                                |
| DELETE `/productos/{id}/imagen/{imageId}/` | B       | remove image                                                                                                                                  |
| PATCH `/productos/{id}/imagen/{imageId}/`  | M       | update image                                                                                                                                  |
| GET `/categorias/`                         | B       | filters, forms, buyer catalog                                                                                                                 |
| GET `/unidades/`                           | B       | forms, wizard picker                                                                                                                          |

**Categorías / unidades admin CRUD (12, M only — web equivalents are hardcoded mocks)**

| Method + path (per entity `e` ∈ {categorias, unidades}) | Purpose            |
| ------------------------------------------------------- | ------------------ |
| GET `/{e}/trash/`                                       | trash view         |
| POST `/{e}/`                                            | create             |
| PATCH `/{e}/{id}/`                                      | edit               |
| DELETE `/{e}/{id}/`                                     | soft delete        |
| POST `/{e}/{id}/restore/`                               | restore from trash |
| POST `/{e}/{id}/permanent/`                             | permanent delete   |

**Municipios / localidades (16)**

| Method + path                            | Used by | Purpose                                                     |
| ---------------------------------------- | ------- | ----------------------------------------------------------- |
| GET `/municipios/`                       | B       | catalogs + admin list                                       |
| GET `/municipios/trash/`                 | B       | admin trash                                                 |
| POST `/municipios/`                      | B       | create                                                      |
| PATCH `/municipios/{id}/`                | B       | edit                                                        |
| DELETE `/municipios/{id}/`               | B       | soft delete                                                 |
| POST `/municipios/{id}/restore/`         | B       | restore                                                     |
| POST `/municipios/{id}/permanent/`       | B       | permanent delete                                            |
| PATCH `/municipios/{id}/estado/`         | W       | toggle `{estado}` (mobile toggles via POST-based mechanism) |
| GET `/municipios/{id}/localidades/`      | W       | profile location selector                                   |
| GET `/localidades/` (+ `?municipio_id=`) | B       | mobile `useCatalogs` scoping; web admin list                |
| POST `/localidades/`                     | B       | create                                                      |
| PATCH `/localidades/{id}/`               | B       | edit                                                        |
| DELETE `/localidades/{id}/`              | B       | soft delete                                                 |
| POST `/localidades/{id}/restore/`        | B       | restore                                                     |
| POST `/localidades/{id}/permanent/`      | B       | permanent delete                                            |
| PATCH `/localidades/{id}/estado/`        | W       | toggle                                                      |

**Publicaciones (12, all B)** — GET `/publicaciones/`; GET `/publicaciones/{id}/`; POST `/publicaciones/`; DELETE `/publicaciones/{id}/`; POST `/publicaciones/{id}/publish/`; POST `/publicaciones/{id}/close/`; GET `/publicaciones/{id}/productos/`; POST `/publicaciones/{id}/productos/`; PATCH `/publicaciones/{id}/productos/{itemId}/`; DELETE `/publicaciones/{id}/productos/{itemId}/`; POST `/publicaciones/{id}/productos/{itemId}/imagen/`; GET `/publicaciones/current/`.

**Pedidos (5, all B)**

| Method + path                                                                        | Purpose                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| POST `/pedidos/` `{items:[{id_producto_semanal,cantidad}]}` + Idempotency-Key header | checkout creation; response `{ok,message,data:Pedido}` (envelope-validated on mobile) |
| GET `/pedidos/`                                                                      | role-scoped lists (buyer history, vendor panel `?estado=`)                            |
| GET `/pedidos/{id}/`                                                                 | order detail (raw `OrderDetail` with `estado_actual` + `historial`)                   |
| PATCH `/pedidos/{id}/status/` `{nuevo_estado}`                                       | seller status transitions                                                             |
| GET `/pedidos/{id}/historial`                                                        | admin order timeline — **no trailing slash** (§4.4)                                   |

**Pagos (4, all B)** — GET `/tipos-pago/`; POST `/pagos/` (+ Idempotency-Key); GET `/pagos/{id}/`; GET `/pagos/?pedido={id}` (reconcile lookup; also plain list via `fetchPagos`). All through `legacy/rassa_front/packages/common/src/payments.ts`.

**Recolecciones (5)** — GET `/recolecciones/` (B; filters `estado, fk_agricultor, fecha, fecha_desde, fecha_hasta`; web adds 30s-deadline fetch-all); POST `/recolecciones/` (B, Idempotency-Key); POST `/recolecciones/{id}/estado/` (B); POST `/recolecciones/{id}/cancelar/` (B); GET `/recolecciones/agricultores/` (**W**, paginated fetch-all for the AgricultorSelector).

**Cortes (3, all B)** — GET `/cortes/`; GET `/cortes/teorico/?fecha=`; POST `/cortes/ {monto_real, fecha}`.

**Liquidaciones (3, all B, admin)** — GET `/liquidaciones/` (filters; safe-next fetch-all); GET `/liquidaciones/{id}/`; POST `/liquidaciones/{id}/marcar-pagada/ {tipo_pago, referencia?}`.

**Mermas (1, B, admin)** — GET `/mermas/resumen/` (`fecha_desde, fecha_hasta, producto_id, agrupar_por`).

**Familias (11, all B, admin)** — GET `/familias/grupos/`; GET `/familias/grupos/trash/`; POST `/familias/grupos/`; PATCH/DELETE `/familias/grupos/{id}/`; POST `/familias/grupos/{id}/restore/`; POST `/familias/grupos/{id}/permanent/`; POST `/familias/grupos/{id}/asignar-jefe/`; GET/POST `/familias/miembros/`; DELETE `/familias/miembros/{id_familia_usuario}/`.

**Chat (15, all B)** — see §7 table.

### 4.2 Response envelope conventions (per-endpoint, documented in `legacy/rassa_front/web/src/services/orderTypes.ts`)

| Pattern                                                                        | Endpoints                                                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ data: { count, next, previous, results } }` (DRF page inside data envelope) | most list endpoints                                                                                                                            |
| `{ ok, message, data: Pedido }` wrapped                                        | POST `/pedidos/` (mobile validates → `InvalidOrderEnvelopeError` treated as ambiguous outcome)                                                 |
| raw `{ results?: [...] }` (no envelope)                                        | GET `/pedidos/` list                                                                                                                           |
| raw body                                                                       | GET `/pedidos/{id}/` (`estado_actual` + `historial`, deliberately not conflated with POST's `estado`); `/tipos-pago/`; `/pagos/*`; `/cortes/*` |
| `{ ok, data, message }`                                                        | `/liquidaciones/*` (`unwrapLiquidacionesEnvelope`); business errors can arrive `ok:true` on HTTP 400/409 — callers branch on HTTP status       |
| Waste envelope                                                                 | `/mermas/resumen/` (`unwrapWasteEnvelope`)                                                                                                     |
| `{ok,data}` / `{results,next}` dual unwrap                                     | mobile pagination walker (`unwrapOk`)                                                                                                          |

_Inference (evidence: per-endpoint unwrapping everywhere)_: envelope handling is inconsistent per endpoint; a rewrite must map envelopes per endpoint, not globally. Mobile report also noted the GET `/pedidos/` envelope is handled as both `{results}` and `ApiResponse<{results}>` across call sites — backend contract should be confirmed by the backend audit.

### 4.3 Auth token handling per app

| Concern                   | Mobile (`legacy/rassa_front/src/services/api.ts` + `storage.ts`)                                                                                                                                                                                                                                       | Web (`legacy/rassa_front/web/src/services/api.ts` + `AuthProvider.tsx`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token storage             | storage facade: expo-secure-store (native) / window.localStorage (web build of the app); keys `access_token`, `refresh_token`                                                                                                                                                                          | access → localStorage `token`; refresh → **sessionStorage** `refresh_token` (dies with tab close; session survives restart only while access token is valid)                                                                                                                                                                                                                                                                                                                                                                                         |
| Attach                    | request interceptor adds Bearer from storage                                                                                                                                                                                                                                                           | same; `PUBLIC_ENDPOINTS` (`/token/`, `/auth/register/`) skip the header                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Refresh                   | 401 (non-auth endpoints) → single-flight `refreshTokens` (POST `/token/refresh/`, 8s abort timeout) → retry original request once (`_retry` flag); failure → clear tokens + `onAuthExpired` callback (registered by AuthContext); auth endpoints (`/token/`, `/token/refresh/`) skip refresh and clear | 401 (not on `/login`, URL not in `NO_REDIRECT_ON_401` = ['/auth/change-password/','/token/refresh/']) → single-flight refresh (plain axios, 10s timeout); concurrent 401s queued and replayed; refresh token rotated if response includes one; anti-loop `refreshRetried` set keyed method+url+params → second 401 after fresh retry = invalid session → `clearAuthAndRedirect` (clears storage, rejects queue, redirect preserving `from` via `legacy/rassa_front/web/src/services/navigate.ts` bridge; relative-only fallback, open-redirect safe) |
| Refresh failure semantics | binary: success or force logout                                                                                                                                                                                                                                                                        | **fatal vs transient**: 400/401/403 or malformed refresh = fatal (logout); network/timeout/408/422/429 = transient (session kept, queued requests rejected with friendly message)                                                                                                                                                                                                                                                                                                                                                                    |
| Retry                     | axios-retry: `API_RETRY_LIMIT`, exponential, network/idempotent methods or status ≥ 500, never 429, never POST                                                                                                                                                                                         | axios-retry: idempotent methods, skips ERR_CANCELED + 429, network-or-idempotent or 5xx; **plus custom per-request-key retry window**: key = method+url+serialized params, 10s window, max 6 failures/window, FIFO eviction at 1000 keys, cleared on success                                                                                                                                                                                                                                                                                         |
| Error surfacing           | non-401 errors get `safeMessage = parseApiError` (UI-safe; raw preserved for Sentry)                                                                                                                                                                                                                   | `SafeMessageError` attaches `safeMessage` without mutating `message`; `reportError()` sends sanitized axios errors to Sentry (never raw AxiosError, avoids leaking Authorization)                                                                                                                                                                                                                                                                                                                                                                    |

### 4.4 The `/pedidos/{id}/historial` trailing-slash anomaly

Both call sites request `/pedidos/${orderId}/historial` **without a trailing slash**, unlike every other DRF path used by the frontend (spot-checked: `legacy/rassa_front/src/hooks/useOrderTimeline.ts` line 26 and `legacy/rassa_front/web/src/routes/AdminOrderDetail.tsx` line 31). Backend tolerance (redirect, 404, or both) must be confirmed by the backend audit.

---

## 5. State & data layer

### 5.1 Client state per app

| Concern      | Mobile                                                                                                                                                                                                                                                                               | Web                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth         | `legacy/rassa_front/src/store/AuthContext.tsx` (545 lines, React Context + useState, **not zustand**): `{user, isLoading, isAuthenticated, isRegistering}`; login/logout/register/updateProfile/changePassword; ROLE_MAP normalizes backend role strings → English canonical (`admin | administrator                                                                                                                                                                                       | administrador→admin`, `farmer | agricultor | productor→farmer`, `seller | vendedor→seller`, `buyer | cliente | comprador→buyer`); **unknown role throws** (deny-by-default); registers the api force-logout callback; `parseAuthError` maps statuses to Spanish messages (429, 502/503/504, 401, 403, 500) | `legacy/rassa_front/web/src/providers/AuthProvider.tsx` + `legacy/rassa_front/web/src/hooks/useAuth.ts`: `{user, token, isAuthenticated, isLoading}`; on mount with token → GET `/auth/me/` validation; 401 clears all storage; transient errors keep the token but `isAuthenticated=false`; cross-tab logout sync via `storage` event on `token`; login writes `token` + `user` |
| Theme        | `legacy/rassa_front/src/store/ThemeContext.tsx`: light/dark/system persisted under `color_scheme_preference` via the storage facade; syncs NativeWind scheme                                                                                                                         | `legacy/rassa_front/web/src/providers/ThemeProvider.tsx`: light/dark/system; localStorage `theme`; matchMedia listener; module-load initial class apply (+ inline pre-paint script in `index.html`) |
| Cart         | zustand + persist, AsyncStorage key `rassa-cart`                                                                                                                                                                                                                                     | zustand + persist, localStorage key `rassa-cart`; manual cross-tab `storage` listener → `rehydrate()`                                                                                               |
| State-in-URL | route params                                                                                                                                                                                                                                                                         | `AdminFamilyDetail` familyId via `useSearchParams`                                                                                                                                                  |

### 5.2 react-query

Both apps on @tanstack/react-query v5 with mutations + `invalidateQueries` on every mutation. Defaults differ: mobile QueryClient staleTime 30s, retry 1, exponential backoff capped 30s; web `legacy/rassa_front/web/src/providers/QueryProvider.tsx` staleTime 5min, retry 1, refetchOnWindowFocus false, with per-query overrides (`QUERY_OPTIONS`: staleTime 30s, retry 3, refetchOnWindowFocus/Reconnect true). Chat polls are interval-based (§7).

Query key families observed (web ≈ 28; mobile defines its own via hooks): `categories`, `unidades`, `farmer-productos`(+search,cat), `productos-catalog`, `publicaciones`(+{estado,page}, +id, +id,'productos'), `pedidos`(+filtro), `pedidos-cliente`, `pedido`+id, `tipos-pago`, `pago`+id, `PAGOS_CLIENTE_QUERY_KEY`+userId(+id) (from `@rassa/common/payments`), `recolecciones`(+filter,today; +'todas',today), `cortes`, `cortes-teorico`, `merma-resumen`(+filters), `settlements`(+filters), `farmers`, `settlement`+id, `admin-users`, `current-user`, `admin-families`, `admin-families-trash`, `admin-family-detail`+id, `order-history`+id, `municipios`, `localidades`(+municipioId), `user-search`, chat keys (from `@rassa/chat` queryKeys), plus mutation key `['create-order']`.

Optimistic-update patterns (web): farmer product delete (`setQueryData` + rollback on error), VendorCorteCaja create (`cancelQueries` + snapshot rollback), AdminSettlementDetail (setQueryData). Mobile: invalidation-driven; wizard and forms manage their own state.

### 5.3 Places that bypass react-query (both apps)

- Mobile `CatalogScreen` (buyer catalog): useState/useEffect direct calls.
- Web `BuyerHome` and `BuyerCatalog`: useEffect + useState fetches; **BuyerHome silently ignores load failures**.
- Mobile `MermaResumenScreen`: manual fetch state machine.
- Mobile `ProductListScreen`: direct api calls instead of the `useProductos` hooks.

### 5.4 Server-state helpers

- Mobile `legacy/rassa_front/src/services/pagination.ts` `fetchAllPages`: walks DRF next links up to 20 pages, dual unwrap (`unwrapOk`), dedupe, partial-failure tolerance, deadline, safe-next enforcement (`isApiUrl`) with Sentry reports. `legacy/rassa_front/src/services/settlements.ts` has a stricter variant (throws on first-page error, truncation flag, same-origin next guard).
- Web `legacy/rassa_front/web/src/utils/pagination.ts` `fetchAllPages` (maxDurationMs + errores count + `{data,errores,truncated}`) and the settlements service variant with the CONV-2 safe-next guard.

---

## 6. Checkout & payment integrity (behavioral spec for the rewrite)

This is the most defensive area of the codebase. Documented precisely because duplicate-order and lost-response bugs are money bugs.

### 6.1 Mobile checkout (`legacy/rassa_front/src/screens/common/CheckoutScreen.tsx`, 591 lines + `legacy/rassa_front/src/services/checkoutPersistence.ts`)

1. Validate cart items; compute subtotal / IVA / total (`IVA_RATE = 0.21` from `legacy/rassa_front/src/utils/money.ts` line 6 — spot-checked; money tests assert it as the single source of the rate).
2. `createIdempotencyKey` → `saveInFlightOrder` (AsyncStorage key `rassa-checkout-in-flight`: `{idempotencyKey, payload, productNames, total, createdAt}`) **before** POST `/pedidos/` (request carries `Idempotency-Key` header). Best-effort writes: persistence failures are swallowed by design.
3. Success → clearCart + clearInFlightOrder + replace onto OrderSuccess.
4. **Ambiguous failure** (timeout / network error without response) → `findMatchingOrder` reconciliation against GET `/pedidos/` (match by total + products + recency window 60s); `InvalidOrderEnvelopeError` is treated as ambiguous.
5. Mount-time reconciliation: if a persisted in-flight record exists, `findOrderByRecord` runs before anything else.
6. Sentry tagging `flow:checkout`.

### 6.2 Mobile payment idempotency (`legacy/rassa_front/src/screens/seller/PaymentScreen.tsx`)

One stable idempotency key per order persisted so a retry (even after app restart) reuses it: key `idem_pago_{orderId}` read/written through the storage facade (`Storage.getItemAsync`/`setItemAsync`, spot-checked lines 47–54). No cleanup of these entries was found (grep for `removeItem`/`clear` in the file: zero hits) — same accumulation gap as web (§6.4).

### 6.3 Web checkout guard (`legacy/rassa_front/web/src/services/checkoutGuard.ts`, 419 lines + `legacy/rassa_front/web/src/services/orders.ts` + `legacy/rassa_front/web/src/routes/BuyerCheckout.tsx`, 537 lines)

Mechanics, in order:

1. **Pre-write ambiguous marker**: an optimistic "ambiguous" marker is written to **both** localStorage and sessionStorage (`rassa-checkout-ambiguous`) BEFORE the POST — protects against reload/tab-close mid-flight.
2. **Cross-tab in-flight lock**: `rassa-checkout-in-flight` `{tabSessionId, idempotencyKey, timestamp, fingerprint}` (TTL 60s) blocks concurrent checkout from another tab; write-then-verify narrows (does not eliminate) the TOCTOU window; per-tab session id in sessionStorage `rassa-checkout-tab-session`.
3. **Idempotency key stable per payload fingerprint**: `rassa-checkout-idempotency` `{key, fingerprint}` — the same cart fingerprint reuses the same Idempotency-Key. Single-record limitation: interleaved different payloads rotate the key.
4. **Payload re-validation**: `clampOrderItems` re-validates the persisted cart (integer 1..stock, dedupe by product id) before POST. POST `/pedidos/` sends `{items:[{id_producto_semanal,cantidad}]}` with the Idempotency-Key header and **axios-retry disabled per-request** (retries could duplicate).
5. **Ambiguous outcome detection**: network error without response (excluding ERR_CANCELED) OR malformed 2xx envelope (`MalformedOrderResponseError`). On ambiguity: marker persisted in both storages, `console.warn` marker `checkout/ambiguous-order` in every environment + Sentry `logError`.
6. **Re-confirmation gate**: re-checkout is blocked until the user acknowledges the "Ya revisé mis pedidos" banner; dismissal marker `rassa-checkout-ambiguous-dismiss`; cross-tab dismissal via `storage` event keyed by `attemptId` (legacy markers without attemptId degrade to per-tab dismiss).
7. **Late success surfacing**: `rassa-checkout-placed` `{id_pedido, timestamp}` surfaces "Tu pedido N°X se confirmó" when success resolved after the user navigated away.
8. Client computes subtotal + IVA (`IVA_RATE = 0.21`, `legacy/rassa_front/web/src/constants/order.ts` line 10; comment there flags it as documented debt S-1 — backend `settings.IVA_RATE` is Decimal "0.21") + total; mutation-level callbacks survive unmount; success → clearCart + navigate `/cliente/pedidos/{id_pedido}`.
9. `extractOrderError` handles DRF non-field error arrays (e.g. `["Stock insuficiente…"]`).

_Inference (per code comments W-4)_: POST `/pedidos/` idempotency is client-side best-effort — the header may be ignored by the backend; the ambiguous marker is the real safety net. Server handling of `Idempotency-Key` is a backend-audit question (§11).

### 6.4 Storage keys involved (checkout/payment)

| Key                                | Storage                               | App | Content / role                                                                                                                                            |
| ---------------------------------- | ------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rassa-checkout-in-flight`         | AsyncStorage (M) / localStorage (W)   | B   | in-flight order record; mobile `{idempotencyKey,payload,productNames,total,createdAt}`, web `{tabSessionId,idempotencyKey,timestamp,fingerprint}` TTL 60s |
| `rassa-checkout-ambiguous`         | localStorage + sessionStorage         | W   | ambiguous-order marker (dual storage)                                                                                                                     |
| `rassa-checkout-ambiguous-dismiss` | localStorage                          | W   | user acknowledged banner                                                                                                                                  |
| `rassa-checkout-idempotency`       | localStorage                          | W   | `{key, fingerprint}` per-fingerprint idempotency key                                                                                                      |
| `rassa-checkout-placed`            | localStorage                          | W   | `{id_pedido, timestamp}` late-success banner                                                                                                              |
| `rassa-checkout-tab-session`       | sessionStorage                        | W   | per-tab session id for the lock                                                                                                                           |
| `idem_pago_{orderId}`              | storage facade (M) / localStorage (W) | B   | payment idempotency key per order; **no cleanup found in either app** (accumulates one entry per paid order forever)                                      |

---

## 7. Chat — `@rassa/chat` package

### 7.1 Package shape (`legacy/rassa_front/packages/chat/`)

Domain core with zero UI: `createChatApi(axios)` factory (`legacy/rassa_front/packages/chat/src/api/chatApi.ts`), path constants (`legacy/rassa_front/packages/chat/src/api/endpoints.ts`), DTOs/adapters/mappers, `queryKeys`, domain types/enums/rules (message edit/delete windows), utils (date formatting, attachments with `sanitizeFileName`). Both apps wrap it with thin service files (`legacy/rassa_front/src/services/chat.ts` is 5 lines: `createChatApi(api)`; web equivalent `legacy/rassa_front/web/src/services/chat.ts`) so the shared JWT/refresh/retry interceptor behavior applies to chat too.

### 7.2 The 15 HTTP operations (methods spot-checked in `chatApi.ts`)

| Method + path                                               | Operation                                            |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| GET `/chat/usuarios/conversaciones/`                        | conversation list                                    |
| GET `/chat/conversaciones/{id}/mensajes/?page={n}`          | paginated messages                                   |
| POST `/chat/mensajes/enviar/`                               | send text                                            |
| POST `/chat/mensajes/enviar-con-documento/`                 | send media (multipart)                               |
| POST `/chat/conversaciones/crear-privada/`                  | create private conversation                          |
| POST `/chat/conversaciones/crear-grupal/`                   | create group                                         |
| PATCH `/chat/conversaciones/{id}/leer/`                     | mark read                                            |
| PATCH `/chat/mensajes/{id}/editar/`                         | edit message (window-gated by `useCanModifyMessage`) |
| PATCH `/chat/mensajes/{id}/inactivar/`                      | soft-delete message                                  |
| GET `/chat/conversaciones/{id}/integrantes/`                | group members                                        |
| PATCH `/chat/conversaciones/{id}/renombrar/`                | rename group                                         |
| POST `/chat/conversaciones/{id}/agregar-integrante/`        | add member                                           |
| DELETE `/chat/conversaciones/{id}/integrantes/{usuarioId}/` | remove member                                        |
| PATCH `/chat/conversaciones/{id}/override-nombre/`          | per-user display-name override                       |
| GET `/chat/usuarios/buscar/?q=`                             | user search                                          |

(Transcription note: the mobile exploration report listed editar/inactivar/leer/renombrar as POST; the shared `chatApi.ts` source — the single source of truth both apps call — uses PATCH. Spot-check resolved in favor of PATCH.)

### 7.3 Per-app wiring

| Aspect                   | Mobile                                                                                                                                                                                                                                     | Web                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Screens                  | ChatListScreen, ChatScreen (infinite scroll + attachments), CreateGroupScreen, GroupDetailScreen, StartChatScreen                                                                                                                          | ChatListPage, ChatDetailPage (339 lines), CreateGroupPage, GroupDetailPage, StartChatPage (under `legacy/rassa_front/web/src/routes/chat/`) |
| Hooks                    | 17 in `legacy/rassa_front/src/features/chat/` (useConversations … useAudioRecorder, useCanModifyMessage) + 9 components                                                                                                                    | 16 hooks in `legacy/rassa_front/web/src/hooks/chat/` + 10 components                                                                        |
| Imports of `@rassa/chat` | 32 across `src/`                                                                                                                                                                                                                           | full core via 16 hooks                                                                                                                      |
| Refresh strategy         | **poll-based**: useConversations refetchInterval 10s base, doubling to 60s max on failures, only while screen focused; useChatMessages 5s base (infinite query, page param from next URL); `refetchIntervalInBackground: false` everywhere | same polling model through the shared package + web hooks                                                                                   |
| Media                    | expo-document/image pickers + expo-audio recording; upload via `enviar-con-documento`; media URLs resolved via `mediaUrl()`                                                                                                                | same endpoints; `useAudioRecorder` voice notes; ImageModal viewer                                                                           |
| Role gating              | ChatList FAB hidden for buyer                                                                                                                                                                                                              | "Nuevo chat" hidden for `rol cliente` (UI-level only — ChatListPage/StartChatPage; backend enforcement out of frontend scope)               |
| Local persistence        | none beyond react-query cache (no AsyncStorage for chat)                                                                                                                                                                                   | none beyond react-query cache                                                                                                               |

**No websockets anywhere; no local persistence; offline chat = whatever the react-query memory cache retains** (Inference, evidence: absence of any chat storage code).

---

## 8. Local persistence & offline behavior

### 8.1 Storage keys

| App    | Mechanism                                                                                                                                                                                                                                    | Keys                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Mobile | storage facade (`legacy/rassa_front/src/services/storage.ts`): expo-secure-store on native, window.localStorage on web build (comment: tokens survive tab navigation; `storage`-event logout sync; real fix noted as httpOnly cookies + CSP) | `access_token`, `refresh_token`, `onboarding_completed` (native only), `color_scheme_preference`                     |
| Mobile | AsyncStorage direct (only 2 files)                                                                                                                                                                                                           | `rassa-cart` (cartStore persist), `rassa-checkout-in-flight` (checkout persistence)                                  |
| Web    | localStorage                                                                                                                                                                                                                                 | `token` (access), `user` `{id,email,rol}`, `theme`, `rassa-cart`, all `rassa-checkout-*` keys, `idem_pago_{orderId}` |
| Web    | sessionStorage                                                                                                                                                                                                                               | `refresh_token` (**lost on tab close**), `rassa-checkout-ambiguous` mirror, `rassa-checkout-tab-session`             |

### 8.2 Offline behavior — UI-only, both apps

- Mobile: NetInfo offline banners that **block submits** in CrudListScreen, ChangePassword, ProfileEditForm, ProductListScreen, CashClosingScreen, RegisterScreen. No request queue, no sync layer, no offline cache beyond the react-query memory cache. Offline resilience = react-query cache + axios-retry + in-flight order reconciliation.
- Web: **no service worker, no PWA manifest, no workbox** anywhere (grep-confirmed). `legacy/rassa_front/web/src/hooks/useOnline.ts` only mirrors `navigator.onLine`; consumed solely by VendorCorteCaja. "Offline resilience" = storage-blocked-context safety + cross-tab coherence.
- Firefox blocked-storage safe-accessor pattern: ALL web storage access goes through try/catch-wrapped `getLocalStorage`/`getSessionStorage` accessors (Firefox throws on the property getter itself when storage is blocked) — replicated across `services/api.ts`, AuthProvider, checkoutGuard, PaymentPage.
- Security-relevant config observed: web CSP meta (`index.html`: `default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `img-src … http: https:`, `connect-src 'self' http://localhost:8000`, `frame-ancestors 'none'`); Vite dev proxy `/api` and `/documentos` → `http://localhost:8000`. Mobile api client throws if an `http://` non-private host is used in production builds.

---

## 9. Shared packages audit

| Package                                                                                                                 | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Mobile usage                                                                   | Web usage                                                            | Verdict                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `@rassa/common` (`legacy/rassa_front/packages/common/src/`)                                                             | 14 modules from `index.ts`: dates, apiErrors (parseApiError), validation (regexes, isAdult ≥18, validateRegistrationForm/ProfileEdit/PasswordChange, buildRegistrationPayload, CATALOG_TIMEOUT), roles (ROLE_OPTIONS/ROLE_LABELS/UserRole), payments (fetchTiposPago/createPago/fetchPago/fetchPagos/fetchPagoPorPedido, esEfectivo, ORDER_STATUS_READY, PAGOS_CLIENTE_QUERY_KEY, idempotency helpers, esPropietarioPago, esPagoIdValido), orders (isOrderExpired), publicationLabels, settlements (envelope unwrap, buildLiquidacionesUrl, SETTLEMENTS_MAX_PAGES), waste (buildResumenUrl, unwrapWasteEnvelope, decision palette), utils/recolecciones (recoleccionDuplicateKey), apiResponse (parseApiList), networking (API_RETRY_LIMIT), cortes (hoyISO), withTimeout | 70+ imports via `@/common/*` (heaviest: waste 21, payments 18, settlements 13) | 12 modules imported (all except http/withTimeout-adjacent internals) | **Alive, core shared asset**                                           |
| `@rassa/chat` (`legacy/rassa_front/packages/chat/src/`)                                                                 | createChatApi factory, 15 ops, DTOs/mappers/queryKeys, domain rules, utils                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 32 imports                                                                     | full core via 16 hooks                                               | **Alive**                                                              |
| `@rassa/api` (`legacy/rassa_front/packages/api/src/`: `client.ts`, `client.web.ts`, `index.ts`)                         | axios client factory duplicate (RN + web variants)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **0 imports** (grep-verified; only self-references)                            | **0 imports** (web has its own `services/api.ts`)                    | **DEAD package** — a third, nearly identical axios factory nobody uses |
| `@rassa/design-tokens` (`legacy/rassa_front/packages/design-tokens/src/`: colors, spacing, typography, radius, shadows) | token exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **0 imports** (mobile theming lives in `src/constants/colors.ts`)              | **0 imports** (web hardcodes its own palette + Tailwind config)      | **DEAD package**                                                       |

Design note found in `legacy/rassa_front/packages/common/src/payments.ts`: callers pass their own axios instance — mobile and web cannot share one client, which is why each app duplicates the factory and the third copy in packages/api rotted.

---

## 10. Frontend-internal completeness & inconsistencies

### 10.1 Dead code (CONFIRMED)

| Item                                            | Location                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| AdminDashboardScreen + AdminUsersScreen screens | `legacy/rassa_front/src/screens/admin/` (never imported)                                                       |
| Unused mock exports                             | `getFarmerStats`, `getFarmerProducts`, `getRecentSales` in `legacy/rassa_front/src/services/mock/dashboard.ts` |
| Empty UI folder                                 | `legacy/rassa_front/src/components/ui/` ("Shared UI components will go here", exports `{}`)                    |
| `@rassa/api` package                            | `legacy/rassa_front/packages/api/`                                                                             |
| `@rassa/design-tokens` package                  | `legacy/rassa_front/packages/design-tokens/`                                                                   |
| Sample admin routes                             | `legacy/rassa_front/web/src/routes/admin.tsx` (not imported by router)                                         |
| Unused alias                                    | `@root` in web vite/tsconfig (configured, zero imports)                                                        |

### 10.2 Mocked / stubbed surfaces routed in production UI

| Surface                                      | App | Nature                                                          |
| -------------------------------------------- | --- | --------------------------------------------------------------- |
| Buyer home stats                             | M   | MOCK (`getAllProducts`)                                         |
| Seller home stats                            | M   | MOCK (`getSellerStats`)                                         |
| Admin panel stats                            | B   | MOCK stats; functional order lookup                             |
| AdminProductsScreen                          | M   | HARDCODED local CRUD, zero API                                  |
| AdminProducts / AdminCategories / AdminUnits | W   | HARDCODED local-state CRUD via AdminCrudTable, zero persistence |
| SellerSales                                  | W   | MOCK table                                                      |
| FarmerOrders                                 | W   | STUB                                                            |
| ProductDetailScreen (buyer)                  | M   | STUB                                                            |
| NotificationsScreen                          | M   | STUB (web: feature absent entirely)                             |

Consequence for the rewrite: the admin product/category/unit CRUD contract visible in the UI does not exist server-side as used — the real product lifecycle lives on the farmer side (+ wizard). No notifications system exists beyond the stub (no push, no endpoint).

### 10.3 Parallel implementations

- **Three axios client factories**: mobile `legacy/rassa_front/src/services/api.ts`, web `legacy/rassa_front/web/src/services/api.ts`, plus the dead `legacy/rassa_front/packages/api/` — refresh semantics already diverge (fatal-vs-transient refresh failure exists only on web; per-request retry window exists only on web).
- **Two CRUD paradigms**: mobile generic `CrudListScreen` (real API) vs web `AdminCrudTable` (local-state fake) for the same admin domains.
- **Two product update verbs**: PUT (mobile) vs PATCH (web) on `/productos/{id}/`.
- **Two parent-scoping conventions** for localidades (query param vs nested path, §3.2).
- **Two farmer-picker data sources** in recolecciones (admin-users vs `/recolecciones/agricultores/`, §3.7).
- **Two wizard step counts**: 5-step mobile wizard vs 4-step web wizard for the same publication flow.
- **Profile implementations**: shared orchestrator + subcomponents (mobile) vs ProfileComponent + hooks (web) — same endpoints, different field-level validation.

### 10.4 Competing role vocabularies (critical for the rewrite)

- Mobile canonical roles: `farmer | seller | admin | buyer` (AuthContext ROLE_MAP; Spanish backend strings normalized **to English**; unknown throws).
- Web canonical roles: `agricultor | vendedor | admin | cliente` (`legacy/rassa_front/web/src/types/index.ts` `normalizeRole` maps English → **Spanish**, default cliente).
- Two competing `User` types coexist on web: `legacy/rassa_front/web/src/types/index.ts` (field `rol`) vs `legacy/rassa_front/web/src/components/admin-users/types.ts` (field `role`, via `@rassa/common/roles`) — structurally similar, distinct types.
- Both apps also handle the backend's `id_usuario` vs `id` field naming via per-call-site mappers.

### 10.5 Tooling & quality observations

- Web `typecheck` script (`tsconfig.check.json`) covers **only a subset** (merma/settlements screens + their services/utils + a few common modules); full-app type safety happens only in the build's `tsc -b`. Oddity — do not replicate.
- Tests: mobile ~100 files (jest-expo + RTL; coverage concentrated on chat 24 files, settlements, checkout, payments, cart, auth, validation, api/pagination/storage, catalogs, wizard, profile); web 79 files (vitest + jsdom + RTL + **MSW test-only** — `src/test-setup.ts` listens with `onUnhandledRequest:'bypass'`, no browser worker anywhere in dev; handlers cover publicaciones, recolecciones full lifecycle, municipios/localidades, POST /pedidos/, liquidaciones, tipos-pago, admin usuarios; productos CRUD, pagos, cortes, chat, familias, auth, mermas are NOT mocked). Package-level tests exist for common (orders, settlements, waste, recolecciones utils).
- Design language is hybrid on web: Tailwind + pervasive inline styles + legacy `getColors(dark)` palette + shared decision colors; dark-mode coverage uneven (AdminUsers hardcodes its own dark hex values). Mobile hardcodes color literals in places (Login button border `#c03232`, violating its own no-literal rule).
- Money: API returns decimal strings ("500.00"); converted with `Number()` at render; `IVA_RATE = 0.21` duplicated in both apps (`legacy/rassa_front/src/utils/money.ts:6`, `legacy/rassa_front/web/src/constants/order.ts:10`) — the client duplicates the server's tax rate as a frontend constant (documented debt S-1 on web).

---

## 11. Gaps and open questions

Consolidated from both exploration reports + this audit's spot checks. Backend-owned items must be resolved by the backend audit, not assumed.

1. **GET `/pedidos/` role scoping** — no client-side scoping param on seller/admin lists; server-side scoping inferred (mobile `SalesScreen` evidence). Backend-audit item.
2. **IVA rate** — resolved by spot check: `0.21` in both apps (mobile `legacy/rassa_front/src/utils/money.ts:6` + test asserting 0.21 as the single source; web `legacy/rassa_front/web/src/constants/order.ts:10`). Remaining open: rounding rules for `subtotal * 0.21` (mobile test uses `toBeCloseTo`; exact currency rounding unverified from frontend).
3. **Mobile PaymentScreen storage tracing** — resolved by spot check: the idempotency key is persisted under `idem_pago_{orderId}` via the storage facade (`PaymentScreen.tsx:50-54`). Remaining open: no cleanup path found (same accumulation gap as web) — confirm whether any removal exists elsewhere before treating as permanent debt.
4. **`/documentos` proxy** — Vite proxies `/documentos` to the backend but no production fetch call site exists. Refined by spot check: the path appears only as chat attachment document URLs (`url_documento: 'documentos/…'` in mobile chat service tests; `/documentos/foto.jpg` fixture in web ChatBubble tests) — i.e., backend-served document links referenced from chat data. Exact backend route purpose: backend-audit item.
5. **Settlements `ok:true` on HTTP 400/409** — frontend-confirmed caller behavior (branch on HTTP status, R4/R5 comments); server-side envelope semantics: backend-audit item.
6. **`Idempotency-Key` server handling** — header sent on POST `/pedidos/`, `/pagos/`, `/recolecciones/` but documented client-side as best-effort (W-4 comments); the checkout guard's ambiguous marker is the real safety net. Backend-audit item.
7. **`/pedidos/{id}/historial` trailing slash** — both apps call it without a trailing slash; backend tolerance unverified (single call site per app). Backend-audit item.
8. **GET `/pedidos/` envelope** — handled as both `{results}` and `ApiResponse<{results}>` across call sites; backend contract to confirm.
9. **Notifications** — no system beyond the mobile stub screen (no push, no endpoint); web has none at all.
10. **Admin product CRUD contract** — AdminProducts screens (both apps) are prototypes over fake data; no backend contract exercised. Decide: implement or drop in the rewrite.
11. **Buyer catalog category filter** — UI present on both apps, applied on neither (backend lacks `id_categoria` on weekly products per mobile code comment).
12. **Mobile `CrudListScreen` toggle mechanism** — toggle is POST-based to a `toggleEndpoint` or base endpoint; exact toggle URL for categorías/unidades was not pinned during exploration (municipios/localidades web side uses PATCH `/{id}/estado/` instead).
13. **Mobile registration form composition** — `useRegistrationForm` holds 13 form fields; the itemized field list above comes from the web report + shared validator; the exact mobile field set (likely includes password confirmation) was not itemized.
14. **CSP hardening** — web CSP allows `http:` img-src and `connect-src localhost:8000`; production posture is an open decision for the rewrite.
15. **axios-retry per-request retry window** (web-only: method+url+params key, 10s window, max 6, FIFO 1000) — replicate or consciously simplify in the rewrite.
16. **Environment** — no env files are committed; `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_SENTRY_DSN` / `VITE_API_URL` / `VITE_SENTRY_DSN` are names only; default API base is `http://localhost:8000/api` (mobile) and `/api` via Vite proxy (web).
