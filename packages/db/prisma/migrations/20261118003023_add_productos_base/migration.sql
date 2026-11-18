-- CreateTable
CREATE TABLE "producto" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "fk_categoria" UUID NOT NULL,
    "fk_unidad" UUID,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "producto_imagen" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_producto" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "principal" BOOLEAN NOT NULL DEFAULT false,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "producto_imagen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "producto_legacy_id_key" ON "producto"("legacy_id");

-- CreateIndex
CREATE INDEX "producto_fk_categoria_idx" ON "producto"("fk_categoria");

-- CreateIndex
CREATE INDEX "producto_fk_unidad_idx" ON "producto"("fk_unidad");

-- CreateIndex
CREATE UNIQUE INDEX "producto_imagen_legacy_id_key" ON "producto_imagen"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "producto_imagen_storage_key_key" ON "producto_imagen"("storage_key");

-- CreateIndex
CREATE INDEX "producto_imagen_fk_producto_idx" ON "producto_imagen"("fk_producto");

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_fk_categoria_fkey" FOREIGN KEY ("fk_categoria") REFERENCES "categoria_producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_fk_unidad_fkey" FOREIGN KEY ("fk_unidad") REFERENCES "unidad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto_imagen" ADD CONSTRAINT "producto_imagen_fk_producto_fkey" FOREIGN KEY ("fk_producto") REFERENCES "producto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- database.md §4.2/§7: at most ONE principal image per producto (legacy partial-unique
-- parity on es_principal; the setPrincipal flow unsets siblings in the same tx first).
CREATE UNIQUE INDEX "producto_imagen_principal_por_producto" ON "producto_imagen"("fk_producto") WHERE "principal" = true;

-- Django auto-check parity (database.md §7): producto_imagen.orden >= 0.
ALTER TABLE "producto_imagen" ADD CONSTRAINT "producto_imagen_orden_no_negativo" CHECK ("orden" >= 0);
