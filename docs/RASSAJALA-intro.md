# RASSAJALA — Instrucción de continuidad y desarrollo

## 1. Contexto y objetivo del proyecto

Estamos desarrollando una nueva implementación de RassaJala como Progressive Web Application (PWA), independiente del frontend y backend originales.

El objetivo es conservar prácticamente toda la lógica de negocio válida del proyecto original, corregir sus inconsistencias, completar las funcionalidades que quedaron incompletas y desarrollar una aplicación que funcione realmente Online y Offline.

No se busca realizar una migración literal del código anterior.

El sistema original es una referencia funcional y de negocio, no una autoridad técnica. Existen funcionalidades incompletas, implementaciones simuladas, inconsistencias y decisiones técnicas que nunca llegaron a verificarse o solucionarse.

La nueva aplicación debe resolver estos problemas.

### Requisitos obligatorios del proyecto

1. La aplicación debe funcionar Online y Offline.
2. La información de producción debe gestionarse en PostgreSQL mediante Supabase.
3. Cualquier modificación necesaria al esquema de base de datos entregado debe justificarse.
4. Debe desarrollarse un reporte técnico detallado con capturas del desarrollo y funcionamiento de la PWA.
5. Está prohibido reutilizar las implementaciones existentes del frontend y backend originales.

### Filosofía de desarrollo

**Máxima funcionalidad, mínima complejidad.**

Se debe conservar la lógica de negocio válida, corregir errores y completar funcionalidades.

Cuando una funcionalidad sea demasiado compleja para el tiempo disponible, se implementará una versión mínima funcional que conserve su objetivo principal y las reglas esenciales del negocio.

No sobrearquitecturar ni introducir infraestructura que no aporte valor suficiente.

---

## 2. Fuentes de información

Repositorios originales:

- `legacy/rassa_back`
- `legacy/rassa_front`

Documentación de auditoría existente:

- `docs/01-audit/backend-audit.md`
- `docs/01-audit/frontend-audit.md`
- `docs/01-audit/database-audit.md`
- `docs/01-audit/audit-findings.md`
- `docs/01-audit/functional-map.md`

Documento técnico de base de datos original:

- `docs/reference/RASSA_JALA_BD_Documento_Tecnico_v3.pdf` (si está disponible en el repositorio).

### Jerarquía para interpretar las fuentes

1. Requisitos del nuevo proyecto y decisiones de negocio aprobadas.
2. Base PostgreSQL efectivamente entregada al equipo.
3. Modelos del backend original interpretados junto con su historial de migraciones.
4. Código del backend original, incluyendo servicios, validaciones, transacciones y pruebas.
5. Reportes de auditoría.
6. Documento técnico PDF original como referencia de intención y reglas de negocio.
7. SQL histórico archivado, exclusivamente como referencia histórica.

El PDF puede contener definiciones desactualizadas. No debe prevalecer automáticamente sobre las migraciones y el comportamiento comprobado del backend.

Cuando existan contradicciones, distinguir entre:

- Diseño originalmente propuesto.
- Comportamiento realmente implementado.
- Decisión aprobada para el nuevo sistema.

No inventar información para resolver discrepancias.

### Reglas sobre legacy

- No modificar archivos dentro de `legacy/`.
- No reutilizar código del frontend ni backend originales.
- Sí reutilizar conceptualmente las reglas de negocio válidas.
- Utilizar los repositorios exclusivamente para comprender comportamientos y requisitos.

---

## 3. Stack tecnológico aprobado

| Responsabilidad       | Tecnología               |
| --------------------- | ------------------------ |
| Frontend              | React + TypeScript       |
| Routing               | TanStack Router          |
| Estado remoto         | TanStack Query           |
| UI                    | shadcn/ui + Tailwind CSS |
| Runtime               | Bun                      |
| Package manager       | Bun                      |
| Servidor HTTP         | Bun.serve()              |
| API                   | tRPC                     |
| ORM                   | Prisma                   |
| Base de datos central | Supabase PostgreSQL      |
| Base de datos local   | RxDB                     |
| Storage local         | IndexedDB                |
| PWA                   | Vite + Workbox           |
| Monorepo              | Bun Workspaces           |

### Decisiones adicionales

- No utilizar PowerSync.
- No incorporar Express.
- No utilizar microservicios.
- No incorporar Redis, Kafka u otros servicios distribuidos sin necesidad demostrada.
- No introducir múltiples motores de persistencia local.
- No duplicar responsabilidades entre TanStack Query y RxDB.

Bun será responsable del runtime y servidor HTTP. tRPC gestionará el contrato tipado entre frontend y backend.

RxDB será responsable de persistencia local, consultas reactivas y replicación.

PostgreSQL será la fuente de verdad del sistema.

---

## 4. Estado actual del desarrollo

No repetir ni revertir funcionalidades que ya están completadas y verificadas.

### 4.1. DVM1 — Resuelto

Se corrigió el problema de validación de schemas de RxDB en development.

- `getRxStorageDexie()` está envuelto con `wrappedValidateAjvStorage()` únicamente en desarrollo.
- Producción omite el wrapper.
- `rxdb-check` incluye regresiones.
- Escrituras válidas aceptadas.
- Escrituras inválidas rechazadas.

La regresión debe mantenerse permanentemente.

### 4.2. Decisión D-3 — IVA

IVA establecido en **16 %**.

La decisión está registrada en `database.md` y `scope.md`.

Esta decisión reemplaza la tasa histórica del 21 % utilizada por el backend original.

Q-14 queda resuelta mediante la política de redondeo definida en la sección correspondiente de esta instrucción.

### 4.3. Módulo Catálogos — COMPLETADO

El CRUD administrativo de los cuatro catálogos ya está implementado y probado.

Características existentes:

- 16 procedimientos `catalogos.*`.
- Operaciones transaccionales fila + outbox.
- Control de concurrencia CAS mediante `version`.
- Conflictos mediante HTTP 409 cuando corresponde.
- Operaciones de escritura exclusivas para Admin.
- Protección verificada: Agricultor recibe 403.
- Página `/catalogos` protegida.
- Lectura reactiva mediante RxDB.
- Papelera y restauración.
- Sin eliminación permanente desde la interfaz.
- Formularios que solamente se limpian después de la confirmación del servidor.
- Toasts y resincronización posterior a mutaciones.

Verificaciones existentes:

- `slice-e2e`: 12 PASS.
- `rxdb-check`: 5 PASS.
- Build OK.
- Check, lint y check-types: 6/6 limpios.
- PULL de checkpoint antiguo verificado: secuencia 5 recupera el documento mutado v4 y el checkpoint avanza a 52.

Q-29 queda RESUELTA.

No volver a implementar este módulo ni cambiar su arquitectura sin una razón concreta.

### 4.4. Matiz sobre el Outbox existente

El protocolo actual puede tener una demora aproximada de hasta 60 segundos para entregar determinados cambios a otros clientes cuando hay operaciones concurrentes.

Esto es un comportamiento conocido del mecanismo de brechas del outbox, no necesariamente un defecto.

No realizar un cambio de arquitectura para resolverlo anticipadamente.

Existe un posible refinamiento: actualizar localmente la fila confirmada después de cada mutación online. Evaluarlo solamente si las pruebas de uso demuestran que mejora significativamente la experiencia sin comprometer la consistencia.

---

## 5. Decisiones de negocio para resolver preguntas abiertas

Las siguientes decisiones constituyen la propuesta de alcance para el nuevo sistema.

Adoptarlas como valores por defecto del MVP. Cuando una implementación afecte información financiera, permisos o el esquema existente, verificar su compatibilidad y registrar cualquier conflicto antes de aplicar cambios irreversibles.

### Q-19 — Gestión de productos

Distinguir dos conceptos:

**Producto maestro (`producto`)**

- CRUD exclusivo de Administrador.
- Contiene información permanente del catálogo.
- Administra nombre, descripción, categoría y unidad de referencia.

**Producto semanal (`producto_semanal`)**

- Representa la oferta comercial de un producto para una semana.
- El Agricultor puede gestionar sus propias publicaciones.
- Permite definir precio, stock, unidad y fotografías.
- Está sujeto a las reglas del ciclo semanal.

Para el MVP, Vendedor no administra productos maestros ni crea publicaciones propias.

No confundir producto maestro con publicación semanal.

Resolver así la inconsistencia original entre las pantallas de Agricultor y los permisos del backend.

### Q-05 — Aprovisionamiento de Vendedores

Implementar un flujo administrado:

- El registro público crea cuentas de Cliente.
- El Administrador puede asignar o cambiar roles.
- Los Vendedores deben ser aprobados y habilitados administrativamente.
- Los Agricultores también deben ser aprovisionados bajo control administrativo.
- Ningún usuario puede asignarse privilegios por sí mismo.

No desarrollar inicialmente invitaciones sofisticadas.

### Q-07 — Correo electrónico

No implementar para el MVP:

- Verificación de correo.
- Invitaciones por correo.
- Recuperación automática por correo.
- Notificaciones de correo transaccionales.

Sí implementar:

- Inicio de sesión mediante correo y contraseña.
- Cambio de contraseña.
- Restablecimiento administrativo controlado.

Las cuentas creadas administrativamente deben tener un mecanismo seguro de contraseña inicial y cambio obligatorio cuando corresponda.

No almacenar ni distribuir contraseñas temporales en texto plano.

### Q-06 — Asignación de vendedores a pedidos

Implementar un mecanismo de reclamación de pedidos.

Flujo:

1. El Cliente genera un pedido.
2. El pedido inicialmente no tiene vendedor asignado (`fk_vendedor = NULL`).
3. Los Vendedores activos consultan pedidos disponibles.
4. Un Vendedor reclama un pedido.
5. PostgreSQL asigna el pedido de manera atómica.
6. Solamente el Vendedor asignado puede ejecutar las operaciones que le corresponden.
7. Admin puede reasignarlo excepcionalmente.

Evitar que dos Vendedores puedan reclamar simultáneamente un mismo pedido.

Para operaciones presenciales, el Vendedor podrá registrar pedidos en nombre de clientes físicos y quedará asignado automáticamente.

### Q-10 — Límites de crédito

El modelo debe admitir:

- Límite de crédito por familia.
- Límite individual para usuarios sin familia.

Un usuario perteneciente a una familia con crédito compartido debe consumir el saldo de la familia.

El Administrador administra los límites.

Un cliente sin límite de crédito asignado no podrá generar pedidos a crédito.

Propuesta de modificación:

Evaluar sustituir el modelo exclusivamente individual por una entidad `limite_credito` que pueda pertenecer a una familia o a un usuario.

Un límite debe tener exactamente un propietario: familiar o individual.

Garantizar unicidad para cada propietario.

La utilización del crédito deberá considerar los pedidos pendientes de pago y no cancelados, independientemente del estado operativo del pedido.

Este comportamiento debe implementarse y validarse transaccionalmente en PostgreSQL.

Antes de aplicar la migración:

- Comparar con el esquema entregado.
- Verificar datos existentes.
- Justificar la modificación.
- Definir una transición compatible con el modelo actual.

No modificar tablas ni migraciones de producción sin verificar estos puntos.

### Q-14 — Redondeo monetario

IVA aprobado: 16 %.

Política para el MVP:

- Utilizar precisión decimal.
- Calcular los importes monetarios con dos decimales.
- Calcular el IVA sobre el subtotal completo del pedido.
- Utilizar redondeo HALF_UP.
- Redondear a dos decimales.
- Total = subtotal + IVA.
- Persistir los resultados como snapshots del pedido.

Fórmula:

IVA = HALF_UP(subtotal × 0.16, 2)

Total = subtotal + IVA

No utilizar `float` o `Number` como autoridad de cálculos monetarios.

Centralizar los cálculos del dinero en el backend.

La regla debe aplicarse consistentemente a detalles, pedidos, pagos y reportes, sin recalcular históricos con tasas o políticas nuevas.

### Q-25 — Semanas ISO

Utilizar calendario ISO 8601, incluyendo semanas 1–53.

La publicación semanal se identifica mediante su fecha de lunes.

La unicidad debe considerar al Agricultor y la fecha del ciclo, no únicamente el número de semana.

`semana_iso` y `anio_iso` deben derivarse correctamente de la fecha del ciclo.

Mantener la regla de publicación exclusivamente los lunes según la zona horaria de negocio.

No confundir la numeración de publicaciones semanales con los períodos utilizados por liquidaciones.

### Q-22 — Zona horaria

Zona horaria de negocio aprobada:

`America/Mazatlan`

Reglas:

- Los instantes se almacenan en UTC.
- Las fechas operativas se interpretan utilizando la zona horaria de negocio.
- Los cortes diarios, publicaciones y recolecciones deben utilizar el calendario local.
- El frontend y backend deben utilizar la misma política.

---

## 6. Hallazgos adicionales del PDF original

Utilizar el PDF como referencia de intención funcional, teniendo presente que puede estar desactualizado.

### Cliente físico

El documento original identifica:

- Cliente digital.
- Cliente físico sin cuenta, atendido por un Vendedor.

Implementar para el MVP un flujo mínimo de pedido presencial:

- El Vendedor puede generar un pedido en nombre de una persona sin cuenta.
- Registrar nombre y, opcionalmente, teléfono.
- Asociar el pedido al Vendedor.
- No consumir crédito familiar.
- Mantener las reglas de stock, importes, historial y pago.

Verificar la compatibilidad con el modelo actual, especialmente la nulabilidad de `fk_cliente`.

No implementar un módulo completo de cuentas para clientes físicos.

### Cantidades e inventario

Existe una discrepancia:

- El PDF describe `producto_semanal.stock` como NUMERIC(12,2).
- El backend evolucionado utiliza cantidades enteras en su modelo actual.

Para el MVP, conservar cantidades enteras mientras no exista una confirmación de que se necesitan cantidades fraccionarias.

No mezclar cantidades decimales en stock con cantidades enteras en detalles de pedido.

Si el negocio confirma ventas fraccionarias, evaluar la modificación coordinada de stock, cantidades, validaciones y cálculos.

### Roles

Conservar los cuatro roles:

- Administrador.
- Agricultor.
- Vendedor.
- Cliente.

Mantener una única representación canónica en el nuevo sistema.

### Familias y crédito

Conservar la función comunitaria y comercial de las familias.

Una familia puede tener varios clientes, un jefe y un límite de crédito compartido.

La creación y modificación de familias debe respetar la regla de una sola membresía activa por usuario.

### Fuentes funcionales del PDF

Consultar especialmente:

- Páginas 6–7: actores y roles.
- Página 17: producto semanal.
- Páginas 22–23: pedido y detalle.
- Páginas 39–43: reglas de negocio y flujos operativos.
- Páginas 50–52: módulos y funcionalidades previstas.

---

## 7. Calidad de datos: Q-21 y Q-27

No asumir que la base de datos real se encuentra limpia.

### Q-21 — Membresías familiares duplicadas

La regla objetivo es:

Un usuario puede tener varias membresías históricas, pero solamente una membresía activa.

Evaluar una restricción UNIQUE parcial sobre `fk_usuario WHERE estado = true`.

Antes de aplicarla:

- Verificar si existen duplicados históricos.
- Identificar membresías activas duplicadas.
- Definir tratamiento de registros inconsistentes.
- Garantizar que no se pierda información histórica.

El servidor debe validar la regla y PostgreSQL debe protegerla mediante restricciones apropiadas.

### Q-27 — Calidad de los datos

Realizar una revisión de solo lectura de la base entregada.

Comprobar:

- Registros huérfanos.
- Membresías duplicadas.
- Stock negativo.
- Imágenes pendientes de eliminación.
- Pedidos sin vendedor.
- Registros de recibos.
- Estados y catálogos no utilizados.
- Posibles inconsistencias financieras.

No ejecutar limpiezas automáticas.

Clasificar hallazgos y proponer correcciones justificadas.

Si no existe acceso a la base, dejar expresamente pendiente la validación de los datos reales. No inventar resultados.

---

## 8. Reglas de sincronización y funcionamiento Offline-First

Mantener RxDB + IndexedDB y el adaptador de replicación propio mediante tRPC.

### Principios

1. PostgreSQL es la fuente de verdad.
2. RxDB mantiene la información local.
3. PULL descarga cambios confirmados.
4. PUSH transmite cambios locales permitidos.
5. El servidor valida las operaciones.
6. Las operaciones deben ser idempotentes.
7. Los conflictos no deben resolverse indiscriminadamente mediante Last Write Wins.
8. Los usuarios no pueden consultar ni sincronizar información ajena.

### Clasificación de operaciones

**Lectura offline**

- Catálogos.
- Productos.
- Publicaciones previamente sincronizadas.
- Pedidos.
- Historiales.
- Perfil.
- Familias.
- Liquidaciones.
- Información que el usuario tenga permiso de consultar.

**Escritura offline permitida**

- Borradores.
- Mensajes, mediante sincronización eventual.
- Otras operaciones de bajo riesgo expresamente habilitadas.

**Confirmación obligatoria del servidor**

- Confirmación de pedidos.
- Asignación de Vendedores.
- Descuento y restauración de stock.
- Pagos.
- Cortes de caja.
- Liquidaciones.
- Operaciones financieras.
- Modificaciones de límites de crédito.
- Operaciones de administración.

No presentar operaciones pendientes como confirmadas.

### Consistencia

Validar especialmente:

- Checkpoints.
- Paginación.
- Transacciones concurrentes.
- Orden de cambios.
- Idempotencia.
- Eliminaciones.
- Reintentos.
- Recuperación de desconexiones.

No asumir que un timestamp del dispositivo o `updated_at` por sí solo garantiza la consistencia.

No modificar el mecanismo outbox ya validado sin evidencia de un problema real.

---

## 9. Próxima prioridad de desarrollo

### Módulo inmediato: Familias y permisos

Es el siguiente módulo P0 pendiente.

Implementar y completar:

- Administración de familias.
- Creación de familias.
- Asignación de jefe.
- Agregar miembros.
- Eliminar membresías mediante baja lógica.
- Restauración cuando corresponda.
- Regla de una sola familia activa por usuario.
- Protección contra duplicados concurrentes.
- Integración familia-chat.
- Integración con límites de crédito.
- Permisos por rol.

La creación y modificación de una familia debe ser consistente mediante transacciones.

Mantener la sincronización de chat familiar de forma idempotente.

No permitir modificaciones de familias fuera de los permisos establecidos.

### Después: Usuarios y roles

Completar:

- Registro.
- Inicio de sesión.
- Perfil.
- Cambio de contraseña.
- Administración de usuarios.
- Asignación de roles.
- Desactivación y reactivación.
- Aprovisionamiento controlado de Agricultores y Vendedores.

Resolver los problemas de cuentas desactivadas: un usuario con `estado=false` no debe seguir operando mediante un token válido.

### Después: Productos

Completar el ciclo:

- CRUD maestro de Admin.
- Asociación de categorías y unidades.
- Gestión de publicaciones por Agricultor.
- Imágenes.
- Estados y ciclo semanal.
- Catálogo semanal para Clientes.

### Después: Pedidos

Completar:

- Catálogo.
- Filtro por categoría.
- Búsqueda.
- Carrito.
- Checkout.
- Stock.
- Límites de crédito.
- Asignación de Vendedor.
- Panel de gestión.
- Estados e historial.
- Clientes físicos.
- Idempotencia.

### Después: Pagos y operaciones financieras

Completar:

- Registro de pagos.
- Folios.
- Recibos.
- Cortes de caja.
- Liquidaciones.
- Cálculos y snapshots.
- Control contra operaciones duplicadas.

### Después: módulos complementarios

- Mermas.
- Chat.
- Dashboard.
- Reportes.
- Notificaciones básicas.

Las funciones avanzadas de push, realtime y automatización quedan sujetas a tiempo y necesidad.

---

## 10. Prioridades funcionales

Utilizar esta clasificación para controlar el alcance.

### P0 — Obligatorio

Funcionalidades esenciales y requisitos académicos:

- Autenticación y roles.
- Familias y permisos.
- Catálogos.
- Productos.
- Publicaciones.
- Pedidos.
- Pagos.
- Recolecciones.
- Integridad financiera.
- PostgreSQL.
- PWA operativa.
- Persistencia offline.
- Sincronización segura.

### P1 — Importante

- Cortes.
- Liquidaciones.
- Mermas.
- Chat.
- Dashboard.
- Historiales.
- Reportes operativos.

### P2 — Simplificable

- Notificaciones push avanzadas.
- Chat en tiempo real.
- Analítica avanzada.
- Automatizaciones complejas.
- Sincronización avanzada en segundo plano.

Una funcionalidad incluida en el alcance no puede quedar simulada.

Si se simplifica, debe conservar su flujo esencial y completar correctamente las operaciones.

---

## 11. Requisitos de calidad

Cada módulo debe:

- Respetar roles y permisos.
- Utilizar información real.
- Tener validaciones de negocio.
- Manejar errores.
- Garantizar persistencia.
- Mantener integridad relacional.
- Contar con pruebas de las operaciones esenciales.
- Definir su comportamiento offline.
- Mostrar estados de sincronización correctos.

No considerar una operación terminada solamente porque funciona visualmente.

Verificar sus efectos en PostgreSQL.

---

## 12. Organización y documentación

Mantener únicamente estos documentos como referencia arquitectónica:

- `docs/architecture.md`
- `docs/database.md`
- `docs/synchronization.md`
- `docs/scope.md`

Actualizar los documentos existentes cuando una decisión importante cambie.

No crear reportes redundantes, múltiples ADR por cada dependencia ni grandes documentos de seguimiento.

La documentación debe permanecer concisa y útil.

No repetir las auditorías existentes.

No crear instrucciones para conectar este agente con ChatGPT ni generar reportes de contexto para otros agentes.

---

## 13. Autonomía y reglas de trabajo

Trabajar de manera autónoma sobre el repositorio.

No detenerse para solicitar aprobación de decisiones técnicas menores.

Tomar decisiones pragmáticas que respeten el stack y los requisitos definidos.

Cuando aparezca una funcionalidad demasiado compleja:

1. Identificar el objetivo de negocio.
2. Identificar las reglas imprescindibles.
3. Evaluar la alternativa mínima funcional.
4. Implementarla sin comprometer integridad o seguridad.
5. Registrar brevemente la simplificación en el documento existente.

Detenerse y solicitar definición solamente cuando exista:

- Una contradicción importante de negocio.
- Riesgo de pérdida de información.
- Una modificación irreversible a la base de datos.
- Un problema de seguridad.
- Una decisión financiera que no tenga una regla definida.
- Un cambio significativo de arquitectura.

No modificar datos reales sin autorización.

No inventar verificaciones ni declarar terminados módulos que no hayan pasado sus pruebas.

---

## 14. Instrucción inmediata

El objetivo es continuar directamente con el desarrollo del nuevo RassaJala, conservando su lógica de negocio válida, corrigiendo sus problemas originales y entregando una PWA verdaderamente funcional dentro del tiempo disponible.
