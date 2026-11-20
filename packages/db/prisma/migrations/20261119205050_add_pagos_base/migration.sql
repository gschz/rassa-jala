-- CreateTable
CREATE TABLE "tipo_pago" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tipo_pago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pago" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_pedido" UUID NOT NULL,
    "fk_tipo_pago" UUID NOT NULL,
    "folio" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "referencia" TEXT,
    "actor" UUID,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recibo" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_pago" UUID NOT NULL,
    "folio" TEXT NOT NULL,
    "datos" JSONB NOT NULL,
    "emitido_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recibo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_secuencia" (
    "nombre" TEXT NOT NULL,
    "siguiente" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "folio_secuencia_pkey" PRIMARY KEY ("nombre")
);

-- CreateIndex
CREATE UNIQUE INDEX "tipo_pago_legacy_id_key" ON "tipo_pago"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "tipo_pago_nombre_key" ON "tipo_pago"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "pago_legacy_id_key" ON "pago"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "pago_fk_pedido_key" ON "pago"("fk_pedido");

-- CreateIndex
CREATE UNIQUE INDEX "pago_folio_key" ON "pago"("folio");

-- CreateIndex
CREATE INDEX "pago_fk_tipo_pago_idx" ON "pago"("fk_tipo_pago");

-- CreateIndex
CREATE INDEX "pago_creado_en_idx" ON "pago"("creado_en");

-- CreateIndex
CREATE UNIQUE INDEX "recibo_legacy_id_key" ON "recibo"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "recibo_fk_pago_key" ON "recibo"("fk_pago");

-- CreateIndex
CREATE UNIQUE INDEX "recibo_folio_key" ON "recibo"("folio");

-- CreateIndex
CREATE INDEX "recibo_emitido_en_idx" ON "recibo"("emitido_en");

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_fk_pedido_fkey" FOREIGN KEY ("fk_pedido") REFERENCES "pedido_cabecera"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_fk_tipo_pago_fkey" FOREIGN KEY ("fk_tipo_pago") REFERENCES "tipo_pago"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo" ADD CONSTRAINT "recibo_fk_pago_fkey" FOREIGN KEY ("fk_pago") REFERENCES "pago"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- M-2 financial single-row CHECKs (database.md §3.5 / §7.1 M-2 / M-13)
ALTER TABLE "pago" ADD CONSTRAINT "pago_monto_positivo" CHECK ("monto" > 0);
