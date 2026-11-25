# RassaJala — Sincronización offline-first

> Cómo sincroniza una réplica local RxDB con PostgreSQL cuando la conexión va y viene. Protocolo implementado (no un diseño pendiente): outbox transaccional, PULL/PUSH con veredictos, ventana de brecha y conflictos server-wins.

## 1. Componentes

| Componente            | Dónde                                      | Responsabilidad                                                                                                     |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Base local            | `apps/web` — `src/lib/rxdb/`               | RxDB + storage Dexie (IndexedDB); 13 colecciones con schema JSON y `conflictHandler` server-wins                    |
| Gestor de replicación | `apps/web` — `src/lib/rxdb/replication.ts` | Un `replicateRxCollection` por colección con handlers PULL/PUSH propios sobre tRPC                                  |
| Controlador           | `apps/web` — sesión                        | Arranca/detiene replicaciones por usuario autenticado; `replicationIdentifier` aislado por usuario y servidor       |
| Router de sync        | `apps/server` + `packages/api` — `sync.ts` | Procedimientos `pull`/`push` por colección (fábrica común), con validación de sesión, rol y ámbito en cada petición |
| Outbox transaccional  | PostgreSQL — `sync_cambio`                 | Fila append-only escrita en la **misma transacción** que cada mutación de negocio                                   |
| Idempotencia          | PostgreSQL — `sync_operacion`              | Veredicto por operación PUSH, escrito transaccionalmente con el efecto                                              |

Flujo: `React ⇄ RxDB ⇄ tRPC ⇄ Bun.serve ⇄ Prisma ⇄ PostgreSQL`. La replicación siempre pasa por el backend; el cliente nunca ve credenciales de base de datos.

## 2. PULL: PostgreSQL → RxDB

- **Checkpoint**: el último `sync_cambio.id` (bigserial) entregado, por colección. Un bigserial da un **orden total determinista** asignado en la misma transacción del cambio — un cursor por `updated_at` no sirve: en PostgreSQL `now()` se fija al inicio de la transacción y dos transacciones concurrentes pueden committear en orden distinto al de su timestamp, con pérdida de cambios.
- **Ventana de brecha (gap window)**: un `nextval` se asigna al INSERT, no al commit — T1 puede tomar `seq=10`, T2 `seq=11` y committear T2 primero. Entregar `11` y avanzar el checkpoint perdería el cambio de T1. Regla de entrega en 3 condiciones (una fila es entregable solo si es demostrablemente segura):
  1. **Contigua** con el prefijo ya entregado (`seq == último entregado + 1`) — nada por debajo puede seguir en vuelo.
  2. **Bajo el aged head** (`seq ≤ max(sync_cambio.id)` con edad > ventana de gracia de 60 s, mayor que toda transacción de negocio): las seqs faltantes de ese rango pertenecen a transacciones revertidas y se omiten.
  3. **Tras una brecha joven completa**: una brecha cuyo rango completo ya es visible no tiene hueco ⇒ se cruza.
- Cada fila del outbox se resuelve al **estado actual** de su fila de negocio; `operacion='delete'` o fila inexistente → documento con `_deleted: true` (tombstone). El filtrado por rol/ámbito se aplica sobre las filas resueltas.
- **Reintento**: si el PULL falla, RxDB reintenta con el mismo checkpoint; el checkpoint solo avanza con respuesta exitosa aplicada.
- **Rewind**: toda respuesta incluye `headSeq` (head actual del outbox, sin envejecer). Si el checkpoint del cliente es estrictamente mayor, el outbox del servidor se reinició (p. ej. restore de BD): el cliente resetea su checkpoint y re-pullea desde 0 (`rewind.ts`); es seguro porque los upserts sobrescriben y las eliminaciones llegan como tombstones.
- Paginación por lotes; la reanudación tras recarga usa el checkpoint persistido por `replicationIdentifier`.

## 3. PUSH: RxDB → PostgreSQL

- Entrada por operación: `operationId` (UUID del cliente, estable entre reintentos), `docId`, `op` (`create|update|delete`), `nuevoEstado`, `versionAsumida`.
- Servidor, en una transacción por operación:
  1. **Idempotencia**: si `operationId` ya existe en `sync_operacion`, se devuelve su veredicto almacenado sin re-ejecutar (la carrera entre pushes concurrentes se resuelve por PK).
  2. **Permisos y reglas de dominio** (rol, propiedad, stock, crédito, ventanas).
  3. **Versionado**: comparación contra la columna `version` del servidor — el servidor no confía en `_rev` ni en timestamps del cliente.
  4. **Aplicación** de la mutación (`version + 1`) + filas `sync_cambio` + fila `sync_operacion`, todo en la **misma transacción**.
- **Veredicto por documento**: `aplicada` (el estado normalizado llega después por PULL) · `conflicto` (con el estado real del servidor) · `rechazada` (con motivo; sobre un `create` sin fila el servidor sintetiza un tombstone para eliminar el fantasma local).
- Toda decisión de negocio es un veredicto dentro de un HTTP 200 (nunca un error 4xx): los reintentos y la UI de rechazo se apoyan en el veredicto persistido.

## 4. Conflictos: server-wins por colección

No hay Last-Write-Wins global ni comparación de timestamps de cliente:

- **Catálogos (S1)**: server-wins incondicional.
- **Transaccional (S2)** — pedidos, publicaciones: el servidor valida stock/crédito/estados y adjudica; el cliente adopta el estado del servidor y ambos estados quedan conservados en `sync_operacion` como artefacto de revisión.
- **Eventual (S3)** — mensajes: push bidireccional; fusión monotónica de `leido` (solo false→true), estado del servidor para el resto.
- El parche optimista es client-side: la UI aplica el cambio local al instante y lo corrige cuando el servidor devuelve el estado real.

## 5. Qué se escribe offline (y qué no)

| Carril               | Colecciones                                                                          | Canal                                                                      |
| -------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Solo lectura offline | catálogos, productos, imágenes, familias, membresías, límites                        | PULL                                                                       |
| Escritura en cola    | pedidos (creación), borradores de publicaciones, mensajes                            | PUSH de replicación + validación central al sincronizar                    |
| Confirmación online  | pagos, transiciones de pedidos, recolecciones, cortes, liquidaciones, mermas, perfil | mutación tRPC + `operationId` idempotente (nunca documento crudo por PUSH) |
| Solo-online          | logs, auth, tokens                                                                   | sin colección local                                                        |

## 6. Reconexión e higiene de sesión

- Al arrancar, cada replicación reutiliza su checkpoint persistido (`replicationIdentifier` = colección + usuario + URL del servidor).
- Al recuperar conectividad la espera del reintento se omite (`navigator.onLine`); además `reSync()` periódico y en foco de ventana.
- Errores recuperables (red/5xx) reintentan; 401/403 detienen las replicaciones y piden re-autenticación; un rechazo de negocio no se reintenta (veredicto `rechazada`).
- Al cambiar de usuario se purgan localmente los documentos no-tombstone antes de arrancar las replicaciones nuevas.
- **Notificador WebSocket** (`/ws` en el mismo `Bun.serve`): tras cada commit, el servidor notifica a los sockets del destinatario (`mensaje_nuevo`/`leido`) para acelerar el PULL. Es **solo notificador** — nunca transporte de datos: la replicación sigue siendo la fuente de verdad y un polling de 45 s es el fallback si el token expiró a mitad de conexión. El upgrade exige access-JWT válido.

## 7. Pruebas

La batería e2e (`apps/web/e2e/`) valida el protocolo con casos observables, entre ellos: `sync-freshness.test.ts` (entrega fresca bajo ráfagas — valida la regla de ventana de brecha), `sync-freshness`/`role-freshness` (scoping), y por módulo: persistencia offline, reconexión, reintentos idempotentes, conflictos concurrentes, tombstones y cambio de usuario.
