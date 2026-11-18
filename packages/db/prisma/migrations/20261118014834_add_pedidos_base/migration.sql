-- CreateTable
CREATE TABLE "estado_pedido" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estado_pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedido_cabecera" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_cliente" UUID,
    "fk_vendedor" UUID,
    "fk_estado" UUID NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "iva" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "origen" TEXT NOT NULL DEFAULT 'digital',
    "cliente_nombre" TEXT,
    "cliente_telefono" TEXT,
    "notas" TEXT,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pedido_cabecera_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detalle_pedido" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_pedido" UUID NOT NULL,
    "fk_producto_semanal" UUID NOT NULL,
    "nombre_producto" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "precio_unitario" DECIMAL(10,2) NOT NULL,
    "importe" DECIMAL(12,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detalle_pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historial_estado_pedido" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_pedido" UUID NOT NULL,
    "fk_estado" UUID NOT NULL,
    "fecha" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" UUID,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historial_estado_pedido_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "estado_pedido_legacy_id_key" ON "estado_pedido"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "estado_pedido_nombre_key" ON "estado_pedido"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "pedido_cabecera_legacy_id_key" ON "pedido_cabecera"("legacy_id");

-- CreateIndex
CREATE INDEX "pedido_cabecera_fk_cliente_idx" ON "pedido_cabecera"("fk_cliente");

-- CreateIndex
CREATE INDEX "pedido_cabecera_fk_vendedor_idx" ON "pedido_cabecera"("fk_vendedor");

-- CreateIndex
CREATE INDEX "pedido_cabecera_fk_estado_idx" ON "pedido_cabecera"("fk_estado");

-- CreateIndex
CREATE INDEX "pedido_cabecera_creado_en_idx" ON "pedido_cabecera"("creado_en");

-- CreateIndex
CREATE UNIQUE INDEX "detalle_pedido_legacy_id_key" ON "detalle_pedido"("legacy_id");

-- CreateIndex
CREATE INDEX "detalle_pedido_fk_pedido_idx" ON "detalle_pedido"("fk_pedido");

-- CreateIndex
CREATE INDEX "detalle_pedido_fk_producto_semanal_idx" ON "detalle_pedido"("fk_producto_semanal");

-- CreateIndex
CREATE UNIQUE INDEX "historial_estado_pedido_legacy_id_key" ON "historial_estado_pedido"("legacy_id");

-- CreateIndex
CREATE INDEX "historial_estado_pedido_fk_pedido_idx" ON "historial_estado_pedido"("fk_pedido");

-- AddForeignKey
ALTER TABLE "pedido_cabecera" ADD CONSTRAINT "pedido_cabecera_fk_cliente_fkey" FOREIGN KEY ("fk_cliente") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedido_cabecera" ADD CONSTRAINT "pedido_cabecera_fk_vendedor_fkey" FOREIGN KEY ("fk_vendedor") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedido_cabecera" ADD CONSTRAINT "pedido_cabecera_fk_estado_fkey" FOREIGN KEY ("fk_estado") REFERENCES "estado_pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_pedido" ADD CONSTRAINT "detalle_pedido_fk_pedido_fkey" FOREIGN KEY ("fk_pedido") REFERENCES "pedido_cabecera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_pedido" ADD CONSTRAINT "detalle_pedido_fk_producto_semanal_fkey" FOREIGN KEY ("fk_producto_semanal") REFERENCES "producto_semanal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_estado_pedido" ADD CONSTRAINT "historial_estado_pedido_fk_pedido_fkey" FOREIGN KEY ("fk_pedido") REFERENCES "pedido_cabecera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_estado_pedido" ADD CONSTRAINT "historial_estado_pedido_fk_estado_fkey" FOREIGN KEY ("fk_estado") REFERENCES "estado_pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- M-2 financial single-row CHECKs (Prisma cannot express CHECK constraints — database.md
-- §5.2): snapshots >= 0, total = subtotal + iva (exact numeric arithmetic, no IVA rate in
-- the constraint per D-3), origen domain (M-4), cantidad hardened legacy `>= 0` → `> 0`
-- and money snapshots >= 0 on detalle. importe = precio_unitario * cantidad stays
-- application-enforced (money.ts) — numeric(10,2) × int is exact in PG, but the module
-- keeps the formula in the single money entry point (documented in M-12).
ALTER TABLE "pedido_cabecera" ADD CONSTRAINT "pedido_cabecera_dinero_check" CHECK ("subtotal" >= 0 AND "iva" >= 0 AND "total" >= 0 AND "total" = "subtotal" + "iva");
ALTER TABLE "pedido_cabecera" ADD CONSTRAINT "pedido_cabecera_origen_check" CHECK ("origen" IN ('digital', 'presencial'));
ALTER TABLE "detalle_pedido" ADD CONSTRAINT "detalle_pedido_cantidad_check" CHECK ("cantidad" > 0);
ALTER TABLE "detalle_pedido" ADD CONSTRAINT "detalle_pedido_dinero_check" CHECK ("precio_unitario" >= 0 AND "importe" >= 0);
