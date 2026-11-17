# RassaJala — Alcance funcional

**Estado:** Alcance consolidado con la auditoría (`docs/01-audit/`); preguntas abiertas que bloquean módulos registradas en §3.2.

## 1. Objetivo

Reconstruir RassaJala conservando prácticamente toda su lógica de negocio válida, completando las funcionalidades incompletas y corrigiendo inconsistencias técnicas y funcionales.

El nuevo sistema deberá cumplir los requisitos de funcionamiento online, offline y persistencia central en PostgreSQL.

## 2. Principios de alcance

1. No heredar errores del sistema original.
2. No asumir que una funcionalidad funciona porque existe código.
3. No descartar funcionalidades únicamente porque estén incompletas.
4. Priorizar flujos de negocio completos sobre interfaces sofisticadas.
5. Implementar soluciones mínimas funcionales cuando la complejidad no justifique una solución avanzada.
6. No utilizar datos simulados en funcionalidades presentadas como terminadas.
7. Mantener la integridad de las operaciones financieras y de inventario.
8. Documentar decisiones de simplificación relevantes.

## 3. Clasificación de hallazgos

Cada funcionalidad identificada en la auditoría debe clasificarse como:

- CONSERVAR: comportamiento correcto que debe mantenerse.
- CORREGIR: comportamiento existente con errores.
- COMPLETAR: funcionalidad parcial o simulada.
- SIMPLIFICAR: solución avanzada sustituida por una versión mínima funcional.
- NUEVA: funcionalidad requerida por la nueva arquitectura.
- VALIDAR: comportamiento cuya regla de negocio todavía no está confirmada.

### 3.1 Clasificación consolidada por módulo

Referencias: **F-n** = hallazgo confirmado (`docs/01-audit/audit-findings.md` §2); **Q-n** = pregunta abierta (§5 del mismo documento); **FA/FM §n** = sección de `frontend-audit.md` / `functional-map.md`. "Estado en legacy" procede de la matriz de correspondencia y de la tabla de completitud (FM §2 y §5). Toda clasificación deriva de evidencia CONFIRMED de la auditoría; lo no confirmable se marca VALIDAR y no se inventan reglas de negocio. Ninguna funcionalidad simulada se clasifica como operativa.

| Módulo | Clasificación | Prioridad | Estado en legacy | Nota |
| --- | --- | --- | --- | --- |
| Autenticación | CORREGIR | P0 | real (FA §3.1) | El login no verifica `Usuario.estado` (F-01); el modelo de sesión debe definir rotación/revocación de tokens y logout real (F-02/F-03/F-04). |
| Usuarios y roles | CORREGIR | P0 | real (FA §3.13) | Unificar el vocabulario de roles entre capas (F-26, conflicto confirmado en cuatro capas); aprovisionamiento de vendedores sin endpoint (Q-05/Q-06). |
| Familias y permisos | CONSERVAR | P0 | real (FA §3.11) | Regla "una familia activa por usuario" reforzada a nivel servidor/base de datos (F-09); la creación en tres llamadas orquestada por el frontend se consolida en el backend. |
| Catálogos (localidades, municipios, categorías, unidades, tipos de pago, estados) | COMPLETAR | P0 | CRUD real en móvil, web hardcodeada (FA §3.2, §10.2; F-16) | El CRUD de administrador simulado en web se implementa contra endpoints reales; decidir si se conserva o descarta (Q-29). |
| Productos | VALIDAR | P0 | real-calling con desajuste de rol (FM §2.4; F-17/Q-19) | Las escrituras del agricultor apuntan a endpoints solo-Admin; resolver quién es propietario del CRUD del catálogo antes de construir pantallas. |
| Imágenes de producto | CORREGIR | P1 | real (pipeline legacy) (FM §3.4; F-10) | Unificar en un único pipeline; decisión de almacenamiento pendiente (D-1 en `docs/architecture.md` §11); migración de URLs legacy fuera de alcance por ahora. |
| Publicaciones semanales | CONSERVAR | P0 | real (FA §3.4) | Conservar el ciclo borrador→publicado→cerrado con la validación de publicación en el servidor; rango de semana 1–52 vs ISO 53 por confirmar (Q-25). |
| Pedidos (carrito → checkout → confirmación) | CORREGIR | P0 | real + idempotencia solo de cliente (FA §6; F-13/F-14) | Idempotencia server-side obligatoria: el `Idempotency-Key` del sistema original nunca fue leído por el backend (F-13). Revalidación bajo bloqueo y límite de crédito familiar se conservan. |
| Pagos y recibos | CONSERVAR (reforzar) | P0 | real (FA §3.6) | Invariantes financieras en el servidor: `monto = total`, un pago por pedido, folio bajo advisory lock (F-05/F-07); reglas de redondeo del IVA por fijar (Q-14). |
| Recolecciones | CONSERVAR | P0 | real; edición sin frontend (FM §2.8; F-27) | Máquina de estados y unicidad de slot por (agricultor, fecha) en el servidor; la creación offline requiere adjudicación del servidor. |
| Cortes de caja | CONSERVAR | P1 | real (FA §3.8) | Límites de día operativo con la zona horaria de negocio `America/Mazatlan` (F-25); snapshots teórico/diferencia en la creación. |
| Liquidaciones | COMPLETAR | P1 | real de solo lectura; `/calcular/` sin UI (FM §2.10; F-27) | Productizar el disparador de cálculo si el negocio lo confirma (Q-23); `marcar-pagada` idempotente se conserva. |
| Mermas | VALIDAR | P1 | parcial: solo resumen; escrituras sin UI (FM §2.11; F-27) | Completar el registro (descuento de stock) si se confirma la intención de negocio; no portar por defecto. |
| Chat | SIMPLIFICAR | P1 | real con polling (FA §7; F-22) | Versión mínima funcional: polling con persistencia local; el tiempo real queda en P2 (Q-08). |
| Dashboards/estadísticas | COMPLETAR | P1 | mockeado en ambas apps (FA §3.16; F-18) | No existen endpoints de estadísticas; toda métrica del nuevo sistema es una API nueva. |
| Perfil y documentos | CONSERVAR | P1 | real (FA §3.14) | El servido de adjuntos nunca se resolvió en producción (F-24); se resuelve con la decisión D-1. |
| Infraestructura offline/sync | NUEVA | P0 | ausente: offline solo de UI (FA §8.2; F-23) | RxDB + replicación PULL/PUSH; diseño normativo en `docs/synchronization.md`. |
| PWA/instalación | NUEVA | P0 | ausente (F-23) | `vite-plugin-pwa`: manifest, service worker y precarga inicial. |
| Notificaciones push | NUEVA | P2 | stub móvil (FA §3.16; F-19) | Construir o descartar según el negocio (Q-28). |
| Chat en tiempo real | NUEVA | P2 | inexistente; el polling es el único contrato evidenciado (F-22, I-09) | Solo si Q-08 lo justifica tras medir el costo del polling. |

Resumen de conteo por clase: CONSERVAR 6, CORREGIR 4, COMPLETAR 3, NUEVA 4, SIMPLIFICAR 1, VALIDAR 2 (20 módulos). Por prioridad: P0 11, P1 7, P2 2.

### 3.2 Preguntas abiertas que bloquean módulos

Derivado de audit-findings.md §5 (29 preguntas genuinamente abiertas; Q-01…Q-04 quedaron resueltas durante la auditoría). Q-22 (política de zona horaria) queda cerrada por decisión de negocio: `America/Mazatlan` (`docs/architecture.md` §8).

**Bloquean módulos P0** — decisión requerida antes de implementar el módulo afectado:

| Módulo | Preguntas | Qué bloquea |
| --- | --- | --- |
| Productos | Q-19 | Quién puede escribir en el catálogo (propietario del CRUD). |
| Catálogos | Q-29 | Implementar o descartar el CRUD de administrador. |
| Pedidos / Pagos | Q-14 | Reglas de redondeo del IVA antes de fijar el módulo de dinero. |
| Pedidos | Q-06, Q-10 | Asignación de vendedor a pedidos y aprovisionamiento de límites de crédito (sin API de escritura en el sistema original). |
| Usuarios y roles | Q-05, Q-07 | Aprovisionamiento de vendedores; necesidad real de flujos de correo. |
| Publicaciones semanales | Q-25 | Rango de semana 1–52 vs ISO 53 en el diseño del ciclo semanal. |
| Infraestructura offline/sync | Q-21, Q-27 | Calidad de los datos reales (duplicados de `familia_usuario`, stock negativo, huérfanos) para el diseño de la replicación. |

**Aplazables** — no bloquean el inicio: Q-08 (chat en tiempo real, P2), Q-09 (Recibo), Q-11, Q-12 (despliegue), Q-13, Q-15, Q-16, Q-17, Q-18, Q-20, Q-23 (liquidaciones, P1), Q-24, Q-26, Q-28 (notificaciones, P2), Q-30, Q-31, Q-32, Q-33. La lista completa con evidencia y etiquetas está en audit-findings.md §5.

## 4. Prioridades

### P0 — Esencial

Debe completarse para considerar operativo el sistema. Filas de la tabla §3.1 anotadas con su clasificación:

- Autenticación — CORREGIR (F-01…F-04).
- Usuarios y roles — CORREGIR (F-26; Q-05/Q-06).
- Familias y permisos — CONSERVAR (F-09).
- Catálogos — COMPLETAR (F-16; Q-29).
- Productos — VALIDAR (F-17/Q-19).
- Publicaciones — CONSERVAR (Q-25).
- Pedidos — CORREGIR (F-13/F-14).
- Pagos y recibos — CONSERVAR reforzado (F-05/F-07; Q-14).
- Recolecciones — CONSERVAR (F-27).
- PWA/instalación — NUEVA (F-23).
- Integridad financiera — transversal: filas Pedidos, Pagos y recibos y Mermas (F-05/F-06/F-07).
- Persistencia central — transversal: norma en `docs/database.md` (sin fila propia).
- Funcionamiento offline — fila Infraestructura offline/sync (NUEVA).
- Sincronización segura — fila Infraestructura offline/sync (NUEVA); diseño normativo en `docs/synchronization.md`.

Consistencia: las once filas P0 de la tabla §3.1 (Autenticación, Usuarios y roles, Familias y permisos, Catálogos, Productos, Publicaciones semanales, Pedidos, Pagos y recibos, Recolecciones, Infraestructura offline/sync, PWA/instalación) corresponden a esta lista; el resto de ítems son requisitos transversales.

### P1 — Funcionalidad operativa complementaria

Filas de la tabla §3.1 anotadas con su clasificación:

- Dashboard con datos reales — fila Dashboards/estadísticas: COMPLETAR (F-18).
- Imágenes de producto — CORREGIR (F-10; decisión D-1).
- Perfil y documentos — CONSERVAR (F-24).
- Liquidaciones — COMPLETAR (F-27; Q-23).
- Cortes de caja — CONSERVAR (F-25).
- Mermas — VALIDAR (F-27).
- Chat — SIMPLIFICAR (F-22; Q-08).
- Historiales — transversal: capas de consulta sobre datos reales (históricos de pedidos y estados ya existen como real en el sistema original).
- Reportes operativos — transversal: se apoyan en los módulos anteriores, sin módulo propio confirmado.

Completar los flujos existentes y priorizar las operaciones esenciales antes de añadir características avanzadas.

### P2 — Mejoras y sofisticación

Filas de la tabla §3.1 anotadas con su clasificación:

- Notificaciones push avanzadas — fila Notificaciones push: NUEVA (F-19; Q-28).
- Chat en tiempo real — NUEVA (F-22/I-09; Q-08).
- Analítica avanzada, automatizaciones, sincronización en segundo plano avanzada y funciones complementarias de experiencia de usuario — mejoras transversales sin módulo propio confirmado.

Implementar solamente si existe tiempo suficiente y aportan valor al proyecto.

## 5. Criterios para simplificar

Una funcionalidad compleja puede tener una versión mínima funcional cuando:

- Cumpla el objetivo principal.
- Respete las reglas de negocio.
- Mantenga la integridad de los datos.
- Tenga validaciones adecuadas.
- No genere operaciones simuladas.
- No comprometa seguridad.
- Permita una evolución posterior.

No se permite simplificar eliminando controles financieros, permisos o validaciones de integridad.

## 6. Requisitos transversales

### Offline

- La aplicación debe abrir sin conexión después de su instalación y precarga inicial.
- Los datos previamente sincronizados deben estar disponibles.
- Las operaciones offline deben persistirse.
- Debe mostrarse el estado de las operaciones pendientes.

### Online

- Acceso a PostgreSQL.
- Confirmación central de operaciones críticas.
- Sincronización recuperable.

### Seguridad

- Roles y permisos.
- Aislamiento de usuarios.
- Validaciones del servidor.

### Experiencia de usuario

- Indicadores de conectividad.
- Indicadores de sincronización.
- Estados de carga y error.
- Validaciones comprensibles.
- Ninguna operación pendiente debe presentarse como confirmada.

## 7. Criterio de finalización

Una funcionalidad se considera terminada cuando:

1. Su flujo principal funciona de principio a fin.
2. Utiliza datos reales.
3. Respeta los permisos.
4. Persiste correctamente.
5. Maneja errores.
6. Cuenta con pruebas esenciales.
7. Su comportamiento offline está definido.
8. No contiene placeholders que aparenten funcionalidad real.

### 7.1 Criterios de aceptación del corte vertical

El corte vertical inicial (arquitectura de extremo a extremo) se acepta cuando los nueve puntos siguientes están demostrados:

1. React + Bun funcionan como monorepo de workspaces: aplicación web servida y backend ejecutándose en Bun.
2. Backend Bun + tRPC: un procedimiento tRPC funcional expuesto por `Bun.serve` con `@hono/trpc-server` y consumido por el frontend.
3. Prisma → PostgreSQL: Prisma opera sobre PostgreSQL (Supabase) mediante el adaptador de driver `@prisma/adapter-pg`.
4. Persistencia local: RxDB persiste en IndexedDB con el plugin gratuito `getRxStorageDexie` (`rxdb/plugins/storage-dexie`).
5. Lectura offline: los datos previamente sincronizados están disponibles sin conexión.
6. Escritura local: una operación permitida se persiste localmente mientras la aplicación está offline.
7. Replicación PULL: los cambios del servidor llegan al cliente mediante checkpoints.
8. Replicación PUSH: los cambios locales llegan al servidor y se confirman al reconectar.
9. Persistencia verificada en PostgreSQL: los datos empujados existen en la base central tras la reconexión y la recuperación funciona ante un corte de conexión.

Estos criterios se derivan de la estrategia de sincronización (`docs/synchronization.md`) y de la ausencia total de capa offline en el sistema original (F-23).

## 8. Control de alcance

Ante una funcionalidad nueva o compleja, evaluar:

- Valor para el negocio.
- Requisito académico.
- Complejidad.
- Riesgo técnico.
- Tiempo disponible.
- Alternativa mínima funcional.

La prioridad será entregar un sistema completo y confiable antes que uno excesivamente sofisticado e incompleto.
