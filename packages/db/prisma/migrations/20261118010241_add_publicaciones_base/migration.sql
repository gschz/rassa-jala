-- AlterTable
ALTER TABLE "producto_imagen" ADD COLUMN     "fk_producto_semanal" UUID;

-- CreateTable
CREATE TABLE "publicacion_semanal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_agricultor" UUID,
    "fecha_ciclo" DATE NOT NULL,
    "semana_iso" INTEGER NOT NULL,
    "anio_iso" INTEGER NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'borrador',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publicacion_semanal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "producto_semanal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_publicacion" UUID NOT NULL,
    "fk_producto" UUID NOT NULL,
    "fk_unidad" UUID NOT NULL,
    "precio" DECIMAL(10,2) NOT NULL,
    "stock" INTEGER NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'activo',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "producto_semanal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publicacion_semanal_legacy_id_key" ON "publicacion_semanal"("legacy_id");

-- CreateIndex
CREATE INDEX "publicacion_semanal_fk_agricultor_idx" ON "publicacion_semanal"("fk_agricultor");

-- CreateIndex
CREATE INDEX "publicacion_semanal_fecha_ciclo_idx" ON "publicacion_semanal"("fecha_ciclo");

-- CreateIndex
CREATE UNIQUE INDEX "producto_semanal_legacy_id_key" ON "producto_semanal"("legacy_id");

-- CreateIndex
CREATE INDEX "producto_semanal_fk_publicacion_idx" ON "producto_semanal"("fk_publicacion");

-- CreateIndex
CREATE INDEX "producto_semanal_fk_producto_idx" ON "producto_semanal"("fk_producto");

-- CreateIndex
CREATE INDEX "producto_semanal_fk_unidad_idx" ON "producto_semanal"("fk_unidad");

-- CreateIndex
CREATE INDEX "producto_imagen_fk_producto_semanal_idx" ON "producto_imagen"("fk_producto_semanal");

-- AddForeignKey
ALTER TABLE "producto_imagen" ADD CONSTRAINT "producto_imagen_fk_producto_semanal_fkey" FOREIGN KEY ("fk_producto_semanal") REFERENCES "producto_semanal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publicacion_semanal" ADD CONSTRAINT "publicacion_semanal_fk_agricultor_fkey" FOREIGN KEY ("fk_agricultor") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto_semanal" ADD CONSTRAINT "producto_semanal_fk_publicacion_fkey" FOREIGN KEY ("fk_publicacion") REFERENCES "publicacion_semanal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto_semanal" ADD CONSTRAINT "producto_semanal_fk_producto_fkey" FOREIGN KEY ("fk_producto") REFERENCES "producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto_semanal" ADD CONSTRAINT "producto_semanal_fk_unidad_fkey" FOREIGN KEY ("fk_unidad") REFERENCES "unidad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Q-25: uniqueness by (agricultor, fecha de ciclo) — NOT by week number. Partial because
-- fk_agricultor is nullable (legacy SET_NULL); ownerless rows never collide.
CREATE UNIQUE INDEX "publicacion_semanal_agricultor_ciclo_unico" ON "publicacion_semanal"("fk_agricultor", "fecha_ciclo") WHERE "fk_agricultor" IS NOT NULL;

-- M-11 (part 2): at most one ACTIVE offer per maestro product per publication. Soft-removed
-- items (estado='inactivo') keep their row as history (legacy quitar semantics) and the
-- product can be re-added as a new active row.
CREATE UNIQUE INDEX "producto_semanal_oferta_activa_unico" ON "producto_semanal"("fk_publicacion", "fk_producto") WHERE "estado" = 'activo';

-- M-4 domain CHECKs (varchar estados, database.md §5.2: Prisma cannot express CHECKs).
ALTER TABLE "publicacion_semanal" ADD CONSTRAINT "publicacion_semanal_estado_dominio" CHECK ("estado" IN ('borrador', 'publicado', 'cancelado', 'cerrado'));
ALTER TABLE "producto_semanal" ADD CONSTRAINT "producto_semanal_estado_dominio" CHECK ("estado" IN ('activo', 'inactivo'));

-- Q-25: ISO week numbers run 1–53 (legacy check_semana_range capped at 52).
ALTER TABLE "publicacion_semanal" ADD CONSTRAINT "publicacion_semanal_semana_iso_range" CHECK ("semana_iso" BETWEEN 1 AND 53);
ALTER TABLE "publicacion_semanal" ADD CONSTRAINT "publicacion_semanal_anio_iso_range" CHECK ("anio_iso" BETWEEN 2000 AND 2100);

-- Module decisions (>= 0 at the trust boundary; publish enforces precio > 0 / stock > 0
-- app-level, Pu4 parity — 0-priced items may exist in drafts, legacy validate_precio).
ALTER TABLE "producto_semanal" ADD CONSTRAINT "producto_semanal_precio_no_negativo" CHECK ("precio" >= 0);
ALTER TABLE "producto_semanal" ADD CONSTRAINT "producto_semanal_stock_no_negativo" CHECK ("stock" >= 0);

-- M-11: producto_imagen targets EXACTLY ONE owner (maestro producto XOR semanal item).
ALTER TABLE "producto_imagen" ADD CONSTRAINT "producto_imagen_objetivo_unico" CHECK (((("fk_producto" IS NOT NULL))::int + ((("fk_producto_semanal") IS NOT NULL))::int) = 1);

-- M-11: at most ONE principal image per weekly item (sibling of the existing
-- producto_imagen_principal_por_producto; semanal rows have fk_producto NULL, so the
-- two indexes never overlap).
CREATE UNIQUE INDEX "producto_imagen_principal_por_producto_semanal" ON "producto_imagen"("fk_producto_semanal") WHERE "fk_producto_semanal" IS NOT NULL AND "principal" = true;
