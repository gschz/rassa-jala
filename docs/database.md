# RassaJala — Modelo de datos

> Versión pública y resumida. El esquema completo (Prisma, por dominio) vive en `packages/db/prisma/schema/` y la evolución en `packages/db/prisma/migrations/`. Este documento resume la forma normal, las restricciones clave y el registro de modificaciones justificadas (requisito del curso: **toda modificación al modelo original debe justificarse**).

## 1. Forma normal

El esquema v2 se diseñó en **1FN–3FN**:

- **1FN**: sin grupos repetitivos ni columnas multi-valor — las relaciones N:M son tablas explícitas (`familia_usuario`, `integrantes`); los adjuntos de chat son una tabla `documento` referenciada por ruta desde `mensaje` (un adjunto por mensaje).
- **2FN**: cada columna no clave depende de la clave completa — los snapshots de líneas de venta (`precio_unitario`, `importe`) y cabeceras (`subtotal`, `iva`, `total`) son columnas propias con CHECK de coherencia, no dependencias parciales.
- **3FN**: sin dependencias transitivas — el catálogo (`categoria`, `unidad`, `estado_pedido`, `tipo_pago`, `decision_merma`, `roles`) vive en tablas propias referenciadas por FK; los datos derivados que se almacenan (snapshots financieros, `semana_iso`/`anio_iso` derivados de `fecha_ciclo`) son **snapshots históricos** con CHECK de fórmula, no duplicación lógica.

Decisiones de modelado destacadas:

- **PK UUID** (`String @default(dbgenerated("gen_random_uuid()"))`) en las tablas de negocio: permite crear documentos offline con identidad estable (requisito de RxDB) y conservar `legacy_id` único para trazabilidad de importación.
- **Acciones referenciales reales** a nivel BD (`Cascade` / `SetNull` / `Restrict`), no solo en el ORM: hard DELETE solo tras soft-delete y en flujos admin; PROTECT real para filas financieras (`merma.fk_pedido`, `liquidacion_venta.fk_pedido`, `recoleccion.fk_agricultor`).
- **Soft-delete `estado boolean`** en catálogos y familias; **lifecycle varchar** en `publicacion_semanal`, `producto_semanal`, `corte`, `liquidacion`, `recoleccion` (máquina de estados con CHECK de dominio).
- **Columnas de sincronización** en toda tabla replicable: `version` (detección de conflictos), `actualizado_en`/`creado_en`, más las tablas de protocolo `sync_cambio` (outbox) y `sync_operacion` (idempotencia).

## 2. Diccionario de entidades (resumen)

37 modelos. Agrupados por dominio:

| Dominio              | Modelos                                                                                                           | Propósito                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identidad            | `Persona`, `Usuario`, `Rol`, `RefreshToken`                                                                       | Datos personales, perfil de negocio (1:1 persona, rol, correo único), sesiones de refresh (hash). El cambio forzado de contraseña vive en `usuario.debe_cambiar_password`.                                                                                            |
| Ubicación            | `Municipio`, `Localidad`                                                                                          | Catálogo geográfico (FK cascada, trash/restore).                                                                                                                                                                                                                      |
| Familias y crédito   | `Familia`, `FamiliaUsuario`, `LimiteCredito`                                                                      | Grupo familiar con jefe, membresía (una activa por usuario, a nivel BD), límite de crédito con propietario XOR (familia **o** usuario) y `monto >= 0`.                                                                                                                |
| Catálogo de producto | `CategoriaProducto`, `Unidad`, `Producto`, `ProductoImagen`                                                       | Catálogo maestro; imágenes con objetivo XOR (producto maestro o artículo semanal) y "principal" por objetivo.                                                                                                                                                         |
| Oferta semanal       | `PublicacionSemanal`, `ProductoSemanal`                                                                           | Oferta del agricultor por ciclo (fecha de lunes, semanas ISO 1–53); ítems con precio/stock vigentes y una oferta activa por producto y publicación.                                                                                                                   |
| Pedidos              | `EstadoPedido`, `PedidoCabecera`, `DetallePedido`, `HistorialEstadoPedido`                                        | Flujo de 4 estados (pendiente → confirmado → entregado, + cancelado), folio humano `PED-000001`, dinero como snapshots CHECK-eados, historial append-only.                                                                                                            |
| Pagos                | `Pago`, `Recibo`, `FolioSecuencia`                                                                                | Un pago por pedido (UNIQUE `fk_pedido`, nulls-distinct para pagos de dispersión), folios `PAG-…`/`REC-…` bajo advisory lock, recibo 1:1 con el pago.                                                                                                                  |
| Logística y finanzas | `Recoleccion`, `HistorialEstadoRecoleccion`, `Corte`, `Liquidacion`, `LiquidacionVenta`, `Merma`, `DecisionMerma` | Slot único de recolección por agricultor/fecha (índice único parcial excluye cancelados), cierre de caja por vendedor/día con `diferencia` CHECK-eada, liquidación semanal anti-duplicado con snapshot de ventas, mermas con `cantidad > 0` y FK a pedido (Restrict). |
| Chat                 | `Conversacion`, `Integrante`, `Mensaje`, `Documento`                                                              | Conversaciones privadas/grupales (una grupal activa por familia), membresía única, mensajes S3 bidireccionales (ventana de edición de 15 min, `leido` monotónico, tipo `texto\|audio\|imagen\|video`), metadatos de adjuntos (`storage_key` única).                   |
| Sistema              | `Log`, `SyncCambio`, `SyncOperacion`                                                                              | Bitácora append-only (acción, entidad, IP, dispositivo); outbox transaccional y registro de idempotencia del protocolo de sincronización (ver `offline-sync.md`).                                                                                                     |

## 3. Restricciones clave

### CHECKs (integridad de negocio a nivel BD)

| Tipo                              | Restricciones                                                                                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fórmulas financieras (single-row) | `total = subtotal + iva` (pedido) · `importe/precio_unitario >= 0` (detalle) · `diferencia = monto_real - monto_teorico` (corte) · `monto_liquidar = monto_ventas - comision` (liquidación)                                                                                        |
| Montos                            | `pago.monto > 0` · `limite_credito.monto >= 0` · montos de corte/liquidación/liquidacion_venta `>= 0` · `merma.cantidad > 0` · `detalle_pedido.cantidad > 0`                                                                                                                       |
| Dominios                          | `pedido.origen IN ('digital','presencial')` · estados de corte/liquidación/recolección/publicación/producto semanal/mensaje · `persona.sexo IN ('M','F','O')` · `integrantes.rol IN ('admin','miembro')` · `mensaje.tipo IN ('texto','audio','imagen','video')` · semanas ISO 1–53 |
| Propietario único                 | `limite_credito`: XOR familia/usuario · `producto_imagen`: XOR producto/artículo semanal                                                                                                                                                                                           |
| Contenido                         | `mensaje.contenido` vacía prohibida (NULL permitido para mensajes solo-imagen)                                                                                                                                                                                                     |

La tasa de IVA (16 %) **no** se codifica en CHECK: la fórmula es `total = subtotal + iva` y la tasa vive en el helper de dinero (`packages/api/src/money.ts`, centavos enteros HALF_UP), único punto de aritmética de dinero.

### UNIQUE (incluye índices únicos parciales)

| Tabla                               | Restricción                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `usuario`                           | `correo`, `fk_persona`, `fk_rol`-rol único por fila                                                  |
| `familia_usuario`                   | `(fk_usuario) WHERE estado` — una membresía activa por usuario, **imposible de violar por carreras** |
| `limite_credito`                    | parciales por `fk_familia` y por `fk_usuario`                                                        |
| `pago`                              | `folio`; `fk_pedido` (UNIQUE simple: múltiples NULL = pagos de dispersión)                           |
| `recibo`                            | `folio`                                                                                              |
| `publicacion_semanal`               | `(fk_agricultor, fecha_ciclo) WHERE estado <> 'cancelado'`                                           |
| `producto_semanal`                  | `(fk_publicacion, fk_producto) WHERE estado = 'activo'`                                              |
| `producto_imagen`                   | principal por objetivo (2 parciales)                                                                 |
| `recoleccion`                       | `(fk_agricultor, fecha_recoleccion) WHERE estado <> 'cancelado'`                                     |
| `corte`                             | `(fk_vendedor, fecha) WHERE fk_vendedor IS NOT NULL`                                                 |
| `conversacion`                      | `(fk_familia) WHERE estado` — una grupal activa por familia                                          |
| `integrantes`                       | `(fk_usuario, fk_conversacion)`                                                                      |
| `liquidacion` / `liquidacion_venta` | `(agricultor, periodo)` / `(liquidacion, pedido)`                                                    |
| `documento`                         | `storage_key`                                                                                        |
| `refresh_token`                     | `token_hash`                                                                                         |

Prisma no expresa CHECKs ni índices únicos parciales: viven como snippets SQL en las migraciones.

## 4. Registro de modificaciones al modelo original

El esquema v2 parte del modelo legacy (Django). Cada modificación se registró con los 8 puntos del formato (problema, tablas, cambio, necesidad, impacto en registros, impacto relacional, impacto Prisma, impacto RxDB/sync). Resumen:

| ID       | Modificación                                                                                                                      | Justificación                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M-1a** | Tabla outbox `sync_cambio` (bigserial, append-only) escrita en la misma transacción que cada mutación                             | Habilita el checkpoint PULL determinista del protocolo offline-first                                                                                     |
| **M-1b** | Columna `actualizado_en` en tablas sincronizables                                                                                 | Filtrado incremental y depuración; el cursor autoritativo sigue siendo el outbox                                                                         |
| **M-2**  | Invariantes financieras como CHECK single-row (`total = subtotal + iva`, etc.)                                                    | En el legacy vivían solo en la app y los datos lo demostraban violado; con escrituras multi-cliente el servidor debe ser garante último                  |
| **M-3**  | PK UUID + `legacy_id` único                                                                                                       | Identidad estable para documentos offline (RxDB); trazabilidad de importación                                                                            |
| **M-4**  | CHECKs de dominio no financieros + "una familia activa por usuario" como índice único parcial                                     | El legacy lo forzaba solo en el serializador; a nivel BD es a prueba de carreras                                                                         |
| **M-5**  | Índices de rutas calientes (`mensaje(conversacion, creado_en)`, `logs(creado_en DESC)`, etc.)                                     | Listados y PULL filtrado por colección                                                                                                                   |
| **M-6**  | `merma.fk_pedido` con Restrict                                                                                                    | Alineación con el modelo auditado; trazabilidad financiera real a nivel BD                                                                               |
| **M-7**  | `logs`: PK UUID, `ip varchar(45)`, `accion`, `entidad`/`detalle` jsonb                                                            | Prisma no tiene `inet`; bitácora de auditoría consultable por Admin                                                                                      |
| **M-8**  | Entidad `LimiteCredito` con propietario XOR familia\|usuario                                                                      | Regla de negocio: límite con exactamente un propietario; "sin límite → sin pedidos a crédito"                                                            |
| **M-9**  | Familias: PK UUID, columnas de sync, UNIQUE parcial de membresía activa, FKs con acciones reales                                  | Escrituras multi-cliente concurrentes; scoping PULL por identidad (3 colecciones: familias, membresías, límites)                                         |
| **M-10** | `usuario.debe_cambiar_password`                                                                                                   | Provisión de credencial inicial segura con cambio forzado (compuerta en `protectedProcedure`)                                                            |
| **M-11** | Publicaciones: imagen con objetivo XOR, unicidad por ciclo (fecha de lunes, ISO 1–53), oferta activa única                        | Fotos por artículo con la misma pipeline de storage; unicidad por ciclo de negocio                                                                       |
| **M-12** | Pedidos: esquema base v2 (UUID, snapshots CHECK-eados, `cantidad > 0`, clientes físicos sin cuenta, folio `PED-…`)                | Invariantes financieras al nivel BD; creación en cola offline; flujo de 4 estados (desviación de flujo intencional y registrada respecto al legacy de 7) |
| **M-13** | Pagos: folio secuencial bajo advisory lock, recibo 1:1, `fk_pedido` UNIQUE (nulls-distinct para dispersión)                       | Idempotencia server-side de dinero; un pago por pedido                                                                                                   |
| **M-14** | Recolecciones: slot único a nivel BD (índice parcial excluye cancelados), máquina de estados CHECK-eada                           | La unicidad del slot se adjudica en el servidor, no por carrera de app                                                                                   |
| **M-15** | Cortes: unicidad vendedor/fecha a nivel BD, `diferencia` como CHECK                                                               | Cierre de caja por día sin duplicados                                                                                                                    |
| **M-16** | Liquidaciones: anti-duplicado any-state, snapshot `liquidacion_venta`, pago de dispersión `fk_pedido NULL`                        | Liquidaciones repetidas y snapshots vacíos eran violaciones reales del legacy                                                                            |
| **M-17** | Mermas: `cantidad > 0`, catálogo `decision_merma` con UNIQUE, descuento de stock serializado con `FOR UPDATE`                     | El descuento de stock nunca se ejecuta dos veces (idempotencia por `operationId`)                                                                        |
| **M-18** | Chat: `mensaje` S3 bidireccional (ventana 15 min, `leido` monotónico, adjuntos por `documento`), notificador WebSocket Bun-native | Único flujo bidireccional de alta frecuencia; el WS solo notifica, el PULL es la fuente de verdad                                                        |
| **M-19** | Folio humano de pedido (`PED-000001`) vía `folio_secuencia`                                                                       | Identificación operable en UI/recibos; la misma maquinaria de folios de pagos                                                                            |

Los folios (`PED-`, pagos, recibos) se emiten en transacciones server-side con `pg_advisory_xact_lock` — el cliente jamás genera folios.
