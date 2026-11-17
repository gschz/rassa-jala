-- CreateTable
CREATE TABLE "municipio" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "municipio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "localidad" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_municipio" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "localidad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categoria_producto" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categoria_producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unidad" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "tipo" TEXT,
    "nombre" TEXT,
    "abreviatura" TEXT,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unidad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cambio" (
    "id" BIGSERIAL NOT NULL,
    "tabla_origen" TEXT NOT NULL,
    "id_fila" UUID NOT NULL,
    "operacion" TEXT NOT NULL,
    "actor" TEXT,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_cambio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_operacion" (
    "id" UUID NOT NULL,
    "fk_usuario" TEXT NOT NULL,
    "coleccion" TEXT NOT NULL,
    "doc_id" UUID NOT NULL,
    "op" TEXT NOT NULL,
    "veredicto" TEXT NOT NULL,
    "respuesta" JSONB,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_operacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "municipio_legacy_id_key" ON "municipio"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "localidad_legacy_id_key" ON "localidad"("legacy_id");

-- CreateIndex
CREATE INDEX "localidad_fk_municipio_idx" ON "localidad"("fk_municipio");

-- CreateIndex
CREATE UNIQUE INDEX "categoria_producto_legacy_id_key" ON "categoria_producto"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "unidad_legacy_id_key" ON "unidad"("legacy_id");

-- CreateIndex
CREATE INDEX "sync_cambio_tabla_origen_id_idx" ON "sync_cambio"("tabla_origen", "id");

-- AddForeignKey
ALTER TABLE "localidad" ADD CONSTRAINT "localidad_fk_municipio_fkey" FOREIGN KEY ("fk_municipio") REFERENCES "municipio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
