# RassaJala — Arquitectura técnica

**Estado:** Base arquitectónica aprobada, consolidada con el scaffold actual y la auditoría (`docs/01-audit/`); decisiones pendientes registradas en §11.

## 1. Objetivo

Desarrollar una nueva aplicación RassaJala como Progressive Web Application (PWA), independiente del frontend y backend originales, conservando y completando sus funcionalidades y reglas de negocio.

La aplicación deberá funcionar online y offline, utilizando PostgreSQL como fuente central de información y RxDB como base de datos local.

## 2. Stack tecnológico

| Componente            | Tecnología          |
| --------------------- | ------------------- |
| Frontend              | React + TypeScript  |
| Bundler               | Vite                |
| Runtime backend       | Bun                 |
| API                   | tRPC                |
| ORM                   | Prisma              |
| Base de datos central | Supabase PostgreSQL |
| Base de datos local   | RxDB                |
| Almacenamiento local  | IndexedDB           |
| PWA                   | Workbox             |
| Estado del servidor   | TanStack Query      |
| Estilos               | Tailwind CSS        |
| Componentes UI        | shadcn/ui           |
| Monorepo              | Bun Workspaces      |

No utilizar PowerSync ni incorporar Express como servidor adicional.

### Decisiones de implementación consolidadas

Verificadas contra el scaffold actual (Better-T-Stack monorepo). Referencias: F-n = hallazgos confirmados en `docs/01-audit/audit-findings.md`.

| Área                 | Decisión                                                                                                                                     | Justificación                                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Servidor HTTP        | `Bun.serve` con el adaptador `@hono/trpc-server`                                                                                             | Express 5 está presente en el scaffold y se elimina (restricción del negocio: no usar Express). `@hono/trpc-server` ya es dependencia del scaffold y es el adaptador canónico de tRPC para `Bun.serve`; no se incorpora ningún framework nuevo. |
| Enrutado frontend    | TanStack Router                                                                                                                              | Realidad del scaffold: ya está en `apps/web` (dependencia y plugin de Vite). Sustituye a react-router del sistema original.                                                                                                                     |
| Datos de servidor    | TanStack Query                                                                                                                               | Ya presente en el scaffold y requerido por el stack.                                                                                                                                                                                            |
| Almacenamiento local | RxDB con el plugin gratuito de IndexedDB: `getRxStorageDexie` (`import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'`)             | Verificado en la documentación vigente de RxDB: el storage Dexie es gratuito (Apache 2.0) y envuelve IndexedDB; el storage alternativo "IndexedDB" es premium y no se utilizará. No se usan plugins premium.                                    |
| Replicación          | Protocolo de replicación de RxDB (`rxdb/plugins/replication`, `replicateRxCollection`) con handlers PULL/PUSH propios contra el backend tRPC | El protocolo es código abierto: sincronizar contra backend propio no requiere servicios de pago. El diseño normativo está en `docs/synchronization.md`.                                                                                         |
| ORM                  | Prisma 7 (generador `prisma-client`, runtime Bun) con adaptador de driver `@prisma/adapter-pg`                                               | Ya configurado en `packages/db`. Prisma solo expone advisory locks e índices parciales vía SQL crudo (F-07): cada mecanismo de concurrencia del sistema original se portará como decisión explícita.                                            |
| Variables de entorno | varlock (integración Vite en `apps/web`, codegen en los paquetes)                                                                            | Realidad del scaffold; evita que secretos del servidor lleguen al bundle del frontend (§7).                                                                                                                                                     |
| PWA                  | `vite-plugin-pwa` (Workbox internamente) + `pwa-assets-generator` para manifest e iconos                                                     | Ya presente en `apps/web`; sustituye la ausencia total de service worker del sistema original (F-23).                                                                                                                                           |

## 3. Arquitectura general

La aplicación utilizará una arquitectura de monolito modular.

Componentes principales:

**Frontend React**

- Presentación e interfaz.
- Navegación.
- Módulos funcionales.
- Validaciones de experiencia de usuario.
- Integración con RxDB.
- Estado de conectividad.
- Indicadores de sincronización.

**Persistencia local**

- RxDB como almacenamiento de datos.
- IndexedDB como motor de persistencia.
- Consultas reactivas.
- Gestión de cambios locales.
- Replicación.

**Backend Bun**

- API tRPC.
- Autenticación.
- Autorización.
- Validaciones.
- Reglas de negocio.
- Operaciones transaccionales.
- Sincronización.
- Gestión de conflictos.

**Persistencia central**

- Prisma.
- PostgreSQL en Supabase.
- Integridad referencial.
- Restricciones.
- Índices.
- Transacciones.

## 4. Principios arquitectónicos

1. PostgreSQL es la fuente de verdad.
2. RxDB es una réplica local persistente.
3. Las operaciones permitidas offline deben persistirse localmente antes de sincronizarse.
4. Las operaciones críticas deben confirmarse en el servidor.
5. El cliente nunca debe ser responsable de garantizar la integridad financiera.
6. La sincronización será selectiva por entidad y operación.
7. Los permisos siempre se validarán en el backend.
8. El sistema debe recuperarse de desconexiones y errores de sincronización.
9. No se reutilizarán implementaciones del frontend ni backend originales.
10. Las modificaciones al modelo de datos original deberán justificarse.

## 5. Organización del monorepo

- `apps/web`: aplicación React y PWA.
- `apps/server`: backend Bun y tRPC.
- `packages/api`: contratos y tipos de API compartidos.
- `packages/config`: configuraciones compartidas.
- `packages/db`: Prisma, schemas y acceso a datos.
- `packages/ui`: primitivas de UI compartidas (shadcn/ui sobre base-ui, Tailwind 4); `apps/web` las consume mediante su `components.json` (alias `@rassa-jala/ui/*`).
- `legacy`: repositorios originales, exclusivamente de referencia.
- `docs`: documentación técnica.

Los proyectos de `legacy/` no formarán parte de los workspaces ni del proceso de compilación.

Conciliación con el scaffold actual: `packages/ui` ya existe y aloja las primitivas; `apps/web` contiene la composición específica de la aplicación. No se crearán paquetes ni abstracciones adicionales de compartición de UI salvo necesidad demostrada de reutilización entre aplicaciones (sin sobreingeniería).

## 6. Funcionamiento online y offline

El diseño normativo de la sincronización (protocolo PULL/PUSH, checkpoints, conflictos, idempotencia, eliminaciones y reconexión) se define en `docs/synchronization.md`. Esta sección fija únicamente el comportamiento observable en línea y fuera de línea.

### Online

- Consultar información local mediante RxDB.
- Sincronizar cambios con el backend.
- Confirmar las operaciones críticas en PostgreSQL.
- Actualizar la información local con las respuestas del servidor.

### Offline

- Consultar datos previamente sincronizados.
- Persistir cambios locales permitidos.
- Mantener una cola de operaciones pendientes.
- Informar al usuario del estado real de sus operaciones.
- No presentar operaciones pendientes como confirmadas.

### Reconexión

- Reanudar la sincronización.
- Recuperar cambios pendientes.
- Resolver conflictos.
- Actualizar checkpoints.
- Evitar operaciones duplicadas.

## 7. Seguridad

Concreción para Supabase en esta arquitectura:

- El cliente nunca accede directamente a Supabase; toda operación pasa por el backend tRPC.
- El backend es el único titular de `DATABASE_URL` (cadena de conexión directa a Supabase PostgreSQL). Esta credencial nunca se empaqueta ni se envía al frontend.
- El frontend recibe únicamente `VITE_SERVER_URL` (URL de la API propia). Ninguna clave anon o service de Supabase se distribuye al cliente.
- Al no existir acceso directo del cliente a la base de datos, el aislamiento no depende de RLS: la autorización se aplica en el backend por rol, permiso y propiedad de registro. RLS queda como capa aplicable solo si en el futuro se incorporara algún acceso directo del cliente, algo que esta arquitectura no contempla.
- Las variables se gestionan con varlock; los secretos del servidor no llegan al bundle.
- Toda operación financiera y de inventario se valida en el servidor (F-05/F-06/F-07); el cliente nunca garantiza la integridad.
- Los binarios (imágenes de producto, adjuntos de chat) se gestionan según la decisión pendiente D-1 (§11); sus credenciales o URLs públicas de solo lectura permanecen del lado del servidor, nunca como claves administrativas en el cliente.

## 8. Fechas y zona horaria

Decisión de negocio confirmada: la zona horaria de la operación es `America/Mazatlan` (Nayarit, México).

- Almacenar instantes en UTC.
- Presentar fechas de negocio utilizando `America/Mazatlan`.
- Disponer de una utilidad explícita y única para los límites del día operativo (inicio/fin de día de negocio, semanas ISO para liquidaciones), compartida por backend y frontend como única fuente de la aritmética de fechas.
- Mantener consistencia entre backend, frontend, reportes y base de datos.
- El conflicto de zona horaria del sistema original (es-ar / `America/Argentina/Buenos_Aires` frente a la geografía de Nayarit, F-25) se clasifica CORREGIR: no se hereda ninguna configuración horaria del sistema original.
- Los límites de día afectan cortes, recolecciones y semanas de publicación; su definición por entidad pertenece al modelo de datos (`docs/database.md`).

## 9. Criterio de implementación

Priorizar soluciones sencillas, mantenibles y gratuitas dentro de las posibilidades de infraestructura.

No incorporar microservicios, colas distribuidas, brokers o infraestructura adicional sin una necesidad demostrada.

La arquitectura debe privilegiar la funcionalidad, integridad de datos y facilidad de mantenimiento.

## 10. Riesgos de implementación

Riesgos principales que esta arquitectura hereda de la auditoría del sistema original:

1. **Integridad financiera.** Las invariantes (`monto = pedido.total`, un pago por pedido, stock ≥ 0, límite de crédito familiar, folios únicos) viven hoy solo en código de aplicación (F-05/F-06/F-07). Con escrituras offline deben trasladarse al servidor como decisiones explícitas de validación y concurrencia, no portarse tal cual.
2. **Corrección de la replicación.** La sincronización PULL/PUSH de RxDB con checkpoints, idempotencia y recuperación es la pieza nueva de mayor riesgo: el sistema original no tiene capa de sincronización que portar (F-23). El corte vertical la valida primero antes de construir módulos sobre ella (criterios en `docs/scope.md` §7).
3. **Concurrencia de PostgreSQL.** `pg_advisory_xact_lock`, `select_for_update` ordenado y `nulls_distinct` solo son accesibles desde Prisma vía SQL crudo (F-07): cada mecanismo se portará como decisión consciente y probada.
4. **Repositorios anidados en `legacy/`.** Los `.git` internos del sistema original pueden contaminar herramientas de revisión (diffs, búsquedas, índices de código). `legacy/` es de solo lectura y debe permanecer fuera de los workspaces y de la compilación.
5. **Contratos de API no derivables.** Sobres heterogéneos por endpoint (F-12), parámetros ignorados (F-28) y dos apps paralelas con comportamientos divergentes (F-21) implican que "el comportamiento del sistema original" suele ser uno de dos comportamientos. La nueva API definirá un contrato único y estricto fijado por pruebas.

## 11. Decisiones pendientes

| #   | Decisión                                                            | Estado                                                                                                                      | Propuesta por defecto                                                                    | Impacto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1 | Almacenamiento de binarios (imágenes de producto, adjuntos de chat) | RESUELTA (2026-11-17): Supabase Storage en producción; driver de disco local en dev hasta la integración final con Supabase | Supabase Storage (nativo, sin infraestructura adicional) frente a conservar Google Drive | El sistema original usó Google Drive con dos pipelines divergentes y limpieza manual de huérfanos (F-10). Supabase Storage eliminaría la dependencia externa y el estado `eliminar_pendiente`. La migración de URLs legacy queda fuera de alcance por ahora. Afecta mínimamente a §3/§7 y al módulo "Imágenes de producto" de `docs/scope.md`. Implementación: adaptador de almacenamiento con dos drivers (local-disk para dev con la BD local; Supabase Storage al conectar producción al final de la integración completa). |
