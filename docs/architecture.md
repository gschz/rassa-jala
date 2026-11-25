# RassaJala — Arquitectura técnica

> Versión pública y resumida. El proyecto es una PWA offline-first para el comercio agrícola local: PostgreSQL es la fuente de verdad y RxDB es una réplica local persistente sincronizada por un protocolo propio (ver [`offline-sync.md`](offline-sync.md)).

## 1. Objetivo

Aplicación web progresiva (PWA) que opera en línea y fuera de línea, con PostgreSQL como almacén central y RxDB como base de datos local del navegador.

## 2. Stack tecnológico

| Componente            | Tecnología                                        |
| --------------------- | ------------------------------------------------- |
| Frontend              | React 19 + TypeScript (strict)                    |
| Bundler / PWA         | Vite + `vite-plugin-pwa` (Workbox `generateSW`)   |
| Runtime backend       | Bun (`Bun.serve` nativo, sin Express)             |
| API                   | tRPC v11 + zod v4 (contrato en `packages/api`)    |
| ORM                   | Prisma 7 + `@prisma/adapter-pg`                   |
| Base de datos central | PostgreSQL (local en dev; Supabase en despliegue) |
| Base de datos local   | RxDB 17 (storage Dexie sobre IndexedDB)           |
| Estado del servidor   | TanStack Query                                    |
| Estilos / UI          | Tailwind CSS 4 + shadcn/ui sobre Base UI          |
| Monorepo              | Bun Workspaces (Vite+ como task runner)           |

## 3. Arquitectura general

Monolito modular en tres capas:

**Frontend React (`apps/web`)**

- Presentación, navegación y módulos funcionales.
- Integración con RxDB (consultas reactivas, escrituras locales permitidas).
- Estado de conectividad e indicadores de sincronización.
- Controlador de replicación (arranca/para por sesión de usuario).

**Backend Bun (`apps/server`)**

- `Bun.serve` con Hono y el adaptador `@hono/trpc-server` montando el router tRPC de `packages/api`.
- Autenticación JWT (access token + refresh en cookie httpOnly), autorización por rol y propiedad de registro en cada procedimiento.
- Reglas de negocio, operaciones transaccionales y sincronización (PULL/PUSH por colección).
- Notificador WebSocket de chat en el mismo proceso (`/ws`; JWT validado en el upgrade; **solo notificador** — la fuente de verdad sigue siendo el PULL, con polling de 45 s de fallback).
- Uploads multipart (`/upload/imagenes`, `/upload/documentos`) que hacen puente a los mismos procedimientos tRPC vía `createCaller`.
- Servido de binarios `GET /storage/*`: disco local en dev; con el driver Supabase emite URL firmada de 60 s y responde redirect 302 (el `url` persistido siempre es la ruta estable `/storage/<key>`).

**Persistencia central (`packages/db`)**

- Prisma 7 con schemas por dominio, migraciones SQL y seed.
- Integridad referencial real (CASCADE / SET_NULL / RESTRICT a nivel BD), CHECKs financieros, índices únicos parciales (vía snippets SQL).
- Outbox transaccional `sync_cambio` y registro de idempotencia `sync_operacion`.

## 4. Principios arquitectónicos

1. PostgreSQL es la fuente de verdad.
2. RxDB es una réplica local persistente.
3. Las operaciones permitidas offline se persisten localmente antes de sincronizarse.
4. Las operaciones críticas se confirman en el servidor (nunca se presentan como confirmadas antes).
5. El cliente nunca garantiza la integridad financiera.
6. La sincronización es selectiva por entidad y operación.
7. Los permisos siempre se validan en el backend.
8. El sistema se recupera de desconexiones y errores de sincronización.
9. Toda modificación al modelo de datos original se justifica (registro M en `database.md`).

## 5. Organización del monorepo

- `apps/web`: PWA React (rutas TanStack, RxDB, replicación, e2e).
- `apps/server`: backend Bun (tRPC, WebSocket, storage, uploads).
- `packages/api`: routers y contratos tRPC compartidos (incluye el helper de dinero: centavos enteros, HALF_UP, IVA 16 %).
- `packages/db`: Prisma (schemas por dominio, migraciones, seed, scripts de BD).
- `packages/ui`: primitivas shadcn/ui compartidas.
- `packages/config`: tsconfig base.

## 6. Funcionamiento en línea y fuera de línea

**En línea:** la UI lee de RxDB (consultas reactivas), replica con el backend y confirma las operaciones críticas en PostgreSQL.

**Fuera de línea:** el service worker precachea el shell (index + JS/CSS + íconos/manifest, `navigateFallback: /index.html`) para el arranque en frío; **no** cachea el API ni `/storage/*`. Los datos offline son responsabilidad exclusiva de RxDB: lectura de lo sincronizado, escritura en cola de lo permitido (creación de pedidos, borradores de publicaciones, mensajes) e indicadores honestos de estado (una operación pendiente nunca se muestra como confirmada).

**Reconexión:** las replicaciones reanudan solas (evento `online` y reintento por temporizador; `reSync()` periódico + foco de la ventana), recuperan cambios pendientes, resuelven conflictos server-wins y avanzan los checkpoints solo con respuesta exitosa.

## 7. Seguridad

- El cliente nunca accede directamente a PostgreSQL/Supabase: toda operación pasa por el backend tRPC.
- El backend es el único titular de `DATABASE_URL` y de la service-role key; ninguna credencial administrativa llega al bundle del frontend (el frontend solo recibe `VITE_SERVER_URL`).
- Sin acceso directo del cliente a la BD, el aislamiento no depende de RLS: la autorización se aplica por rol, permiso y propiedad de registro en cada procedimiento.
- Las variables se gestionan con varlock (`.env.schema` por app, codegen a TypeScript).
- Toda operación financiera y de inventario se valida en el servidor; los folios se emiten bajo advisory locks (`pg_advisory_xact_lock`) y las filas críticas se serializan con `SELECT … FOR UPDATE`.

## 8. Fechas y zona horaria

La zona horaria de operación es `America/Mazatlan` (Nayarit, México). Los instantes se almacenan en UTC; la presentación y los límites de día operativo (cortes, recolecciones, semanas ISO de publicación) usan una única utilidad de fechas compartida por backend y frontend.

## 9. Criterio de implementación

Soluciones sencillas, mantenibles y gratuitas dentro de lo posible: sin microservicios, sin colas distribuidas, sin brokers ni infraestructura adicional sin necesidad demostrada.
