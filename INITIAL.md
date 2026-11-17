# Tarea: Auditoría inicial de RassaJala

## Contexto

Este repositorio contiene una nueva implementación de RassaJala.

Los proyectos originales se encuentran en:

- `legacy/rassa_back`
- `legacy/rassa_front`

Estos repositorios son exclusivamente fuentes de referencia para auditoría y análisis.

La nueva aplicación se desarrollará independientemente utilizando:

- Frontend: React + TypeScript.
- Backend: Bun + tRPC.
- ORM: Prisma.
- Base de datos: PostgreSQL en Supabase.
- Base de datos local: RxDB.
- Arquitectura: Offline-First.
- PWA: Vite + Workbox.

## Objetivo de esta tarea

Realizar una auditoría técnica integral de los proyectos originales para comprender sus funcionalidades, modelo de datos, relaciones, reglas de negocio y dependencias.

## Restricciones obligatorias

1. No modificar ningún archivo dentro de `legacy/`.
2. No reutilizar implementaciones del frontend ni del backend originales.
3. No implementar funcionalidades nuevas.
4. No modificar esquemas ni migraciones de bases de datos.
5. No asumir información que no esté respaldada por los repositorios.
6. Diferenciar claramente los hallazgos confirmados de las inferencias.
7. Registrar los archivos y ubicaciones que respaldan cada hallazgo.

## Actividades

### 1. Auditoría del backend

Identificar modelos, entidades, tablas, relaciones, migraciones, restricciones, validaciones, endpoints, operaciones CRUD, autenticación, permisos y reglas de negocio.

### 2. Auditoría del frontend

Identificar módulos funcionales, pantallas, formularios, operaciones disponibles, campos utilizados, filtros, navegación y relaciones entre funcionalidades.

### 3. Auditoría de datos

Reconstruir el modelo de datos existente.

Identificar claves primarias, claves foráneas, relaciones, campos obligatorios, índices, enumeraciones y restricciones.

### 4. Correspondencia frontend-backend

Relacionar las funcionalidades del frontend con los endpoints, modelos y operaciones del backend.

Identificar funcionalidades incompletas, inconsistencias y posibles discrepancias.

### 5. Consideraciones Offline-First

Identificar las entidades que potencialmente necesitarán:

- Persistencia local.
- Lectura offline.
- Escritura offline.
- Sincronización bidireccional.
- Control de versiones.
- Resolución de conflictos.

No implementar estas capacidades ni modificar el modelo de datos.
