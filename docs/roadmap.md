# RassaJala — Roadmap de integración completa

**Estado:** Vivo — se actualiza al cerrar cada fase. Última actualización: 2026-11-18.
**Audiencia:** agentes de desarrollo (humanos o IA) que incorporen trabajo al repositorio. Este documento es el **punto de entrada**: condensa qué está hecho, qué falta, cómo está resuelto y cómo trabajar sin romper nada.

## 0. Cómo usar este documento

1. Lee este documento completo.
2. Lee los 4 documentos normativos: `docs/architecture.md`, `docs/database.md`, `docs/synchronization.md`, `docs/scope.md` (son la autoridad técnica; este roadmap no los reemplaza).
3. Para comportamiento legacy y hallazgos: `docs/01-audit/*.md` (congelados; referencia histórica).
4. Reglas de interpretación de fuentes y autonomía: `docs/RASSAJALA-intro.md` (§2 jerarquía de fuentes, §13 cuándo detenerse).
5. Seguimiento por feature: `odd/tasks/<feature>.md` + Engram (topic `odd/<feature>/tasks`). Encadena tus hallazgos ahí.

**Reglas inquebrantables:** `legacy/**` es READ-ONLY (ni leer para copiar código: solo entender); prohibido reutilizar implementaciones legacy; docs `01-audit/` congelados; commits propiedad del usuario (los agentes nunca ejecutan `git commit`); lint/format al cerrar cada unidad (`bun run check` + `bun run lint`); documentación solo en los 4 docs + este roadmap (sin ADRs ni reportes redundantes).

---

## 1. Entorno y comandos

| Tema | Estado |
|---|---|
| Base de datos de desarrollo | **PostgreSQL local** `rassa_jala_db_v2` (host `localhost`, user `postgres`; `pgcli -h localhost -U postgres -d rassa_jala_db_v2`). `DATABASE_URL` en `apps/server/.env` y `packages/db/.env`. Supabase se conecta **al final** de la integración (decisión del usuario). |
| Base de datos legacy | `rassa_jala_db` (46 tablas, datos reales) — **solo-lectura absoluta**; objetivo de la revisión Q-21/Q-27 (`database.md` §4.7) y del import futuro (M-3). |
| Runtime | Bun 1.4.x, workspaces `apps/*` + `packages/*` (Bun Workspaces). |
| Env | varlock; tras tocar `*.env.schema` ejecutar `bun run env:generate`. `.env` nunca en git (ignorado). |
| Migraciones | Prisma 7 (`prisma migrate dev` en `packages/db`). **Serializar migraciones entre agentes paralelos** (conflicto de lock) o usar `--create-only` + coordinar. |
| Servidores | `bun run dev:server` (:3000) · `bun run dev:web` (:3001). `GET /` = health. |
| Calidad | `bun run check` (oxlint + oxfmt --write) · `bun run lint` · `bun run check-types` · `bun run build` — todos deben quedar limpios al cerrar cualquier unidad de trabajo. |
| Ignorados por decisión | `legacy/`, `.atl/`, `storage/` (binarios dev del driver local), `docs/01-audit/**` (oxfmt congelado). |

**Usuarios de prueba** (seed idempotente `bun prisma/seed.ts` en `packages/db`): `admin@rassa.local` / `RassaDev2026!` (Admin) · `agricultor@rassa.local`, `agricultor2@rassa.local` (Agricultor) · `vendedor@rassa.local` (Vendedor) · `bloqueado@rassa.local` (estado=false, para probar F-01) · cliente de prueba creado por los e2e.

---

## 2. Stack y decisiones inamovibles

React 19 + TypeScript · TanStack Router · TanStack Query · shadcn/ui + Tailwind 4 · **Bun.serve()** (sin Express) · tRPC v11 · Prisma 7 (adapter-pg) · Supabase PostgreSQL (al final; hoy BD local) · RxDB (Dexie/IndexedDB) · Vite + Workbox (vite-plugin-pwa) · Bun Workspaces.

**Prohibido:** PowerSync · Express · microservicios · Redis/Kafka/brokers · múltiples motores de persistencia local · duplicar responsabilidades entre TanStack Query y RxDB.

**Principios:** PostgreSQL es la fuente de verdad; RxDB es réplica local; el cliente NUNCA garantiza integridad financiera; permisos siempre en el backend; TZ de negocio `America/Mazatlan` con instantes en UTC; dinero SIEMPRE con el helper de centavos enteros (nunca float/Number).

---

## 3. Decisiones de negocio aprobadas (resumen — detalle en `scope.md` §3.2 y `database.md` §7)

| Decisión | Resolución |
|---|---|
| Q-19 | Producto **maestro** = CRUD exclusivo Admin. **Producto semanal** = Agricultor (precio, stock entero, unidad, fotos). Vendedor no administra maestros ni publica. |
| Q-05/Q-07 | Registro público → Cliente. Vendedor/Agricultor aprovisionados por Admin. Sin correo en MVP: contraseña inicial segura de un solo uso + cambio obligatorio (`debe_cambiar_password`), reset administrativo. |
| Q-06 | Reclamación atómica de pedidos: `fk_vendedor NULL` al crear; vendedores activos reclaman (1 ganador); Admin reasigna; pedido presencial autoasigna al vendedor. |
| Q-10 | `limite_credito` con **propietario único** (familia XOR usuario); sin límite → sin pedidos a crédito; uso = pedidos pendientes de pago no cancelados. |
| Q-14 / D-3 | IVA **16%**; HALF_UP a 2 decimales sobre el subtotal completo; `total = subtotal + iva` con CHECK en BD; snapshots; no recalcular históricos. |
| Q-21 | Membresía activa única por usuario: UNIQUE parcial en BD + validación transaccional. |
| Q-22 | TZ `America/Mazatlan` (presentación/calendario); instantes UTC. |
| Q-25 | Semanas ISO 8601 (1–53); ciclo identificado por su **fecha de lunes**; unicidad (agricultor, fecha de ciclo); publicar solo lunes. |
| Q-29 | CRUD admin de catálogos: implementado (p0-catalogos). |
| D-1 | Imágenes: **Supabase Storage en producción**; driver local de disco en dev (hasta integración final). |
| Pendientes de decisión | **M-3/D-2**: estrategia de import de datos legacy (ver §7.1). D-7 (backfill `actualizado_en` legacy) va con el import. Ver registro completo en `database.md` §7 (D-1…D-9). |

---

## 4. Fases completadas (verificadas)

Cada fase tiene tracker cerrado en `odd/tasks/<nombre>.md`, espejo Engram (topic `odd/<feature>/tasks`) y batería de pruebas reportada. Resumen de lo entregable:

### F0 — Consolidación + corte vertical (`foundation-consolidation`)
- 4 docs normativos consolidados con la auditoría; 5 entregables de auditoría en `docs/01-audit/`.
- **Corte vertical 9/9**: React+Bun · tRPC · Prisma→PostgreSQL · RxDB/IndexedDB · lectura offline · escritura local · PULL/PUSH · reconexión · persistencia verificada en PG.
- Infra: Express eliminado → `Bun.serve` + `@hono/trpc-server`; outbox `sync_cambio` (bigserial) + `sync_operacion` (idempotencia); seed Nayarit.

### F1 — Autenticación (`p0-auth`)
- `rol/persona/usuario/refresh_token`; JWT acceso 15 min + refresh opaco hasheado en cookie httpOnly con **rotación y revocación familiar**; `Bun.password` (argon2id).
- **F-01 corregido y probado**: login y refresh rechazan `Usuario.estado=false`.

### F2 — Catálogos (`p0-catalogos`)
- 16 procedimientos `catalogos.*` (4 catálogos), Admin-only, patrón outbox, CAS `version` → 409, propagación PULL probada desde checkpoint viejo. Q-29 resuelta.

### F3 — Familias y créditos (`p0-familias`)
- `familia`, `familia_usuario` (UNIQUE parcial BD), `limite_credito` (propietario único XOR), `conversacion`+`integrantes` (integración familia-chat mínima); endurecimiento de token: **rol fresco desde BD en cada llamada protegida** + verificación `estado` por llamada; guardas de último-Admin + advisory locks compartidos. Scoping PULL por rol.

### F4 — Usuarios y roles (`p0-usuarios`)
- Registro público → Cliente; gestión admin (list/detail/create/changeRol/setEstado/resetPassword); contraseña inicial de un solo uso + **puerta de cambio obligatorio** (403 global con allowlist); desactivación **revoca sesiones en la misma tx**; `/registro`, `/perfil`, `/usuarios`, `/cambiar-password`. M-10.

### F5 — Productos (`p0-productos`)
- Producto maestro CRUD Admin + `producto_imagen` (UNIQUE parcial "un principal por producto"); **adaptador de almacenamiento** (`services/storage.ts`: LocalDiskDriver funcional + SupabaseStorageDriver stub D-1) con `GET /storage/*` y guard anti-traversal; colecciones PULL `productos`/`imagenes`. 28 pruebas.

### F6 — Publicaciones semanales (`p0-publicaciones`)
- `publicacion_semanal` (ciclo = fecha de lunes; UNIQUE parcial (agricultor, ciclo) excluyendo cancelado; ISO 1–53 derivado con CHECK; estado domain) + `producto_semanal` (precio Decimal(10,2), stock entero). **M-11**: `producto_imagen` con objetivo XOR (producto | producto_semanal).
- **Primer push S2 real**: borradores del Agricultor con validación de dominio en el servidor y replay idempotente (PG sin cambios); publicar/cancelar/cerrar = confirmación online; **Monday-gate probado determinísticamente** (409 con mensaje exacto en día no-lunes y para ciclos pasados).
- `/publicaciones` (borradores offline con marcador pendiente) + `/catalogo` (Cliente: ofertas del ciclo activo, filtro por categoría, búsqueda). Hueco de scoping detectado por e2e y corregido.

### F7 — Pedidos (`p0-pedidos`)
- `estado_pedido` (lookup con 7 valores del modelo), `pedido_cabecera` (snapshots numeric(12,2) con **CHECK `total = subtotal + iva`** en BD), `detalle_pedido` (CHECK cantidad>0), `historial_estado_pedido` **append-only**.
- **Adjudicación central única** (`money.ts` centavos enteros + HALF_UP IVA 16%): advisory lock `pedidos_adjudicacion` → items publicados → dinero → crédito Q-10 → stock atómico → pedido+detalles+historial+outbox en una tx (centinela `Rechazo` revierte decrementos parciales).
- Reclamación atómica Q-06 (`updateMany WHERE fk_vendedor IS NULL` → 1 ganador); cancelar restaura stock; clientes físicos M-12 (sin crédito, autoasignación).
- Web: carrito **RxDB local sin replicación** + checkout offline en cola ('Pendiente de confirmación' hasta veredicto) + `/mis-pedidos` + `/pedidos-vendedor` (Disponibles/Míos/Presencial) + `/pedidos-admin`. ~50 pruebas.

**Migraciones v2 aplicadas** (orden): `init` → `add_auth_base` → `add_familias_base` → `add_productos_base` → `add_publicaciones_base` (×2) → `ciclo_unico_libera_cancelado` → `add_pedidos_base`.

---

## 5. Fase en curso / inmediata

### P0-A — Pagos (`p0-pagos`) — **ESPEC COMPLETA, SIN EMPEZAR** (worker cancelado sin cambios; tracker `odd/tasks/p0-pagos.md`)
- `pago` (UNIQUE fk_pedido + CHECK monto>0; `registrarPago` **NO recibe monto**: lo deriva el servidor de `pedido.total` — mata la clase F-05 por construcción), `recibo` 1:1 con snapshot jsonb inmutable, contador de folio advisory-locked (`pg_advisory_xact_lock('pagos_folio')`, formato `R-000123`), `tipo_pago` lookup (sembrar valores de `database.md` §6 si no existe en v2).
- Transiciones: `Pendiente → Confirmado` (al pagar) y `Confirmado → Entregado` (vendedor/admin), con historial + outbox.
- **Liberación de crédito**: uso de crédito pasa a contar SOLO `estado='Pendiente'` (refinar `pedidos.ts` adjudicación).
- Online-confirm ONLY (sin push); UI deshabilitada offline; recibo imprimible (`window.print()`, sin lib PDF).
- Respetar tope COL23 de RxDB (§8): pago/recibo visibles vía tRPC (lectura online), NO como colecciones nuevas.

### P0-B — Recolecciones (`p0-recolecciones`) — P0 pendiente
- Dominio legacy: agenda del vendedor para recolectar cosechas del agricultor; **unicidad de slot por (agricultor, fecha) respaldada en BD** (R1); estados + historial. Entidades en `database.md` §3 (`recoleccion` + historial). Creación offline propensa a colisión → adjudicación server-side como pedidos. UI vendedor (agenda) + visibilidad agricultor. Sin bloqueadores de decisión.

### P0-C — Integración final Supabase (al cierre del desarrollo de módulos)
- `DATABASE_URL` de producción + implementar `SupabaseStorageDriver` real (D-1) + bucket/policies + variables de entorno de producción. RLS no aplica (no hay acceso directo del cliente a la BD).

### P0-D — Import de datos legacy (requiere decisión M-3/D-2 del usuario)
- Tratamientos pre-import ya documentados (`database.md` §4.7): **SEVERE** reescribir liquidación 5 hacia pago nuevo (UNIQUE v2 lo rechazaría); `pedido.total` como verdad financiera vs `pago.monto` histórico; descartar membresía inactiva duplicada (usuario 8); tolerancia `drive_file_id NULL`; folios `LEGACY-N` inmutables. Re-verificar el SEVERE contra la BD antes de escribir scripts.
- Estrategia pendiente: mapeo legacy_id → UUID v2, backfill `actualizado_en` (D-7), catálogos sin uso, estados no usados (Q-18: `activo` sin uso — decidir conservar/descartar).

### P0-E — PWA de producción + entregable académico
- Auditoría del offline shell (arranque en frío sin servidor), manifest/íconos (`generate-pwa-assets`), Workbox precache de rutas; 
- **Reporte técnico con capturas** (requisito del proyecto): Playwright MCP para capturas online/offline/sync/PostgreSQL al cierre.

### P0-INF — Reconstruir suites e2e dentro del repo (⚠️ URGENTE)
- Las suites de pruebas de negocio vivían en `/tmp/opencode/*.ts` y **fueron eliminadas por limpieza de /tmp** (2026-11-18). Solo sobreviven `apps/web/scripts/rxdb-check.ts` (5 PASS, incl. DVM1) y `apps/web/scripts/slice-e2e.ts` (9 puntos).
- **Acción**: recrearlas como archivos del repo (`apps/web/scripts/` o `packages/api/scripts/`): `pedidos-e2e`, `publicaciones-e2e`, `publicaciones-push-e2e`, `productos-e2e`, `usuarios-e2e`, `familias-e2e`, `role-freshness-check`. Son ~150 aserciones de negocio (dinero exacto, carreras, idempotencia, scoping, 403s) — la red de regresión de todo lo demás. Reconstruirlas desde los trackers `odd/tasks/*` (cada uno documenta sus pruebas).

---

## 6. Fases restantes P1 y P2

| Fase | Contenido | Notas técnicas |
|---|---|---|
| P1-A Cortes de caja | `corte` (uno por vendedor+fecha), snapshot `teorico/diferencia` al crear; CHECKs de fórmula ya validados contra datos (§4.7) | Fórmulas server-side; fórmula del corte probada 3/3 en datos legacy |
| P1-B Liquidaciones | `liquidacion` + `liquidacion_venta`; reglas L7/L8 (anti-duplicado + pago idempotente); `calcular` server-side | Legacy dejó `liquidacion_venta` vacía y folios LEGACY-N; `fk_pago_liquidacion` SEVERE pre-import |
| P1-C Mermas | `merma` + `decision_merma`; **M-6**: `merma.fk_pedido` nunca aplicada en legacy — v2 la incluye justificada; flujo stock no productizado (F-27) → COMPLETAR mínimo | |
| P1-D Chat | Tabla `mensaje` (+ `mensajes_documentos` si adjuntos); S3 eventual-sync (única colección bidireccional de alta frecuencia); `conversacion`/`integrantes` YA existen (p0-familias); polling → (P2) realtime | Sync: versionado de `leido`, ventanas de edición 15 min |
| P1-E Dashboard real | Reemplazar los dashboards mockeados legacy con datos reales (stats server-side + vistas) | Los stats mockeados legacy eran el único uso de servicios mock |
| P1-F Historiales y reportes operativos | Vistas sobre historial/logs ya append-only; reportes mínimos | |
| P2 | Notificaciones push avanzadas · chat realtime · analítica · automatizaciones · sync background avanzado | Solo si hay tiempo |

---

## 7. Gaps técnicos y deudas registradas (consolidado)

1. **COL23 — RxDB free tier: ~13 colecciones abiertas por base**. La web ya opera cerca del límite (municipios, localidades, categorías, unidades, familias, membresias, limites_credito, productos, imagenes, publicaciones, itemsSemanales, carrito-local). **Regla para nuevos módulos**: preferir embed/compartir o lectura server-fetched (pagos/recibos así lo hacen). No abrir colecciones nuevas sin revisar el conteo.
2. **Ventana de brechas del outbox (~60 s)**: tras ráfagas concurrentes, PULL por colección puede devolver `[]` hasta que los gaps envejezcan (normativo, `synchronization.md` §4.2). Refinamiento candidato (NO hacer sin evidencia): escritura local optimista de la fila confirmada tras mutaciones online.
3. **Upload base64 MVP** (tope 5 MiB, sin magic-bytes: solo mime/ext — `shortcut:` en código). Upgrade: multipart + sniffing (legacy usaba python-magic).
4. **Auto-promoción de imagen principal** al borrar la principal: no implementada.
5. **Ítems huérfanos de una publicación rechazada reintentan indefinidamente** (visibles en `error$`).
6. **Purga local al cambio de usuario** (sync §11) no implementada (lecturas con scoping por identidad — sin fuga conocida).
7. **Delete de foto de item semanal** no implementado (solo upload/setPrincipal).
8. **Tabla `mensaje` diferida** (chat P1); `documento`/adjuntos P2.
9. **Filas 'Producto QA' desactivadas** en papelera dev (limpieza opcional).
10. ** Suites e2e perdidas en /tmp** → P0-INF (§5).
11. **Trabajo sin commit**: productos/publicaciones/pedidos y docs siguen sin commit (66 entradas) — el usuario decide cuándo commitear.
12. **`estado_pedido` 'activo' sin uso** (Q-18, residuo legacy): decidir en el import.

---

## 8. Patrones técnicos establecidos (cómo se hace aquí)

- **Outbox/replicación**: toda mutación escribe fila(s) + `sync_cambio` (tabla_origen, id_fila, operacion) en **UNA transacción Prisma**; PULL por colección con checkpoint = seq contigua (regla de ventana de brechas §4.2); PUSH con veredictos por documento (`aplicada/conflicto/rechazada`) + `sync_operacion` (idempotencia, uuid del cliente).
- **Concurrencia**: CAS por `version` (0 filas → 409); advisory locks con nombres registrados: `usuarios_admin_integridad` (changeRol/setEstado), `pedidos_adjudicacion` (checkout/presencial/push); folio de pago usará `pagos_folio`.
- **Dinero**: SOLO `packages/api/src/money.ts` (centavos enteros, HALF_UP, IVA 16%); snapshots persistidos; el cliente solo muestra 'estimado'.
- **Seguridad**: `protectedProcedure` verifica por llamada `usuario.estado` + `debeCambiarPassword` (allowlist `auth.me/changePassword/logout`) + **rol fresco desde BD** (el claim del JWT no autoriza nada por sí solo); Admin-only con mensajes uniformes; scoping por identidad en cada PULL.
- **Almacenamiento**: adaptador `StorageDriver` (LocalDisk dev / Supabase producción) — se inyecta por Context de la API, nunca importado directo en `packages/api`.
- **Idiomas**: código/comentarios en inglés; copy de UI en español; documentos técnicos en español.
- **M-registro**: toda modificación de esquema justificada con la plantilla de 8 puntos en `database.md` §7 (M-1…M-12 usados; siguiente M-13).
- **Deviaciones**: si la realidad obliga a desviarse de un doc, marca `// doc-deviation:` y actualiza la fila del doc correspondiente.

---

## 9. Mapa de archivos clave

```
packages/db/prisma/schema/{schema,slice,auth,familias,productos,publicaciones}.prisa(+pedidos)
packages/db/prisma/seed.ts                      # idempotente ×2 siempre
packages/db/prisma/migrations/                  # init → add_auth → add_familias → add_productos → add_publicaciones(×2) → ciclo_unico → add_pedidos
packages/api/src/money.ts                       # autoridad de cálculo monetario
packages/api/src/routers/{auth,catalogos,familias,productos,publicaciones,sync,usuarios}.ts (+pedidos)
packages/api/src/index.ts                       # tRPC init + protectedProcedure (estado + puerta cambio + rol fresco)
apps/server/src/index.ts                        # Bun.serve + Hono + @hono/trpc-server + GET /storage/*
apps/server/src/services/storage.ts             # adaptador D-1
apps/web/src/lib/rxddd → rxdb/{database,replication,sync-client,sync-status}.ts  # (ruta real: src/lib/rxdb)
apps/web/src/lib/auth/{http,session,use-login}.ts
apps/web/src/routes/… (15 rutas: login, registro, cambiar-password, perfil, catalogos, familias,
                         productos, publicaciones, catalogo, index(slice), mis-pedidos,
                         pedidos-vendedor, pedidos-admin, usuarios)
apps/web/scripts/{rxdb-check,slice-e2e}.ts      # suites EN EL REPO
odd/tasks/*.md                                  # trackers ODD (cerrados: foundation-consolidation, p0-auth,
                                                #  p0-catalogos, p0-familias, p0-usuarios, p0-productos,
                                                #  p0-publicaciones, p0-pedidos; abierto: p0-pagos)
```

---

## 10. Protocolo para agentes paralelos

1. **Antes de tocar código**: leer este roadmap + los 4 docs + el tracker de tu feature. Crear `odd/tasks/<feature>.md` (checklist con IDs) y espejarlo en Engram (`odd/<feature>/tasks`, `capture_prompt:false`).
2. **Ownership por archivos**: un solo escritor por conjunto de paquetes a la vez. Si dos features van en paralelo, separar por dominio (p. ej. pagos toca `packages/api/pedidos+pagos+web pedidos-*`; recolecciones toca esquema nuevo + routers propios) y **coordinar migraciones** (nunca dos `prisma migrate dev` simultáneos).
3. **Cierre de feature**: batería completa — `bun run check` · `bun run lint` · `bun run check-types` · seed ×2 idempotente · pruebas dirigidas con curl/script (probar TODO lo declarado en el tracker) · suites del repo (`rxdb-check`, `slice-e2e` — este último es dueño del puerto 3000, no arrancar server antes) · `bun run build` · `git status` con footprint solo en rutas propias · `mem_save` + verificar persistencia · **respuesta corta nunca vacía**.
4. **Al terminar una fase**: actualizar `odd/tasks/<feature>.md` (checkboxes + progreso + residuales), espejo Engram, y una línea en este roadmap (§4/§5/§6 según corresponda).
5. **Nunca**: escribir en `legacy/` o `rassa_jala_db`; ejecutar `git commit`/`push`; simular funcionalidad; inventar reglas de negocio; abrir una colección RxDB sin revisar COL23; olvidar el `capture_prompt:false` en saves automatizados.
6. **Cuándo detenerse y preguntar al usuario** (`RASSAJALA-intro.md` §13): contradicción de negocio, riesgo de pérdida de datos, modificación irreversible de BD, problema de seguridad, decisión financiera sin regla, cambio de arquitectura significativo.

---

## 11. Orden sugerido de ejecución (dependencias)

```
P0-INF (suites e2e al repo) ──┐
P0-A pagos ───────────────────┼──► P0-C Supabase final ──► P0-D import legacy (decisión M-3) ──► cierre PWA (P0-E)
P0-B recolecciones ───────────┘        (pagos y recolecciones son paralelizables: dominios disjuntos)
P1 cortes ► liquidaciones ► mermas ► chat ► dashboard ► historiales/reportes   (tras P0-A, P0-B)
P2 (opcional, si hay tiempo)
```
