-- CreateTable
CREATE TABLE "familia" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "fk_jefe_usuario" UUID,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "familia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "familia_usuario" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_usuario" UUID NOT NULL,
    "fk_familia" UUID NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "familia_usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "limite_credito" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "monto" DECIMAL(12,2) NOT NULL,
    "fk_familia" UUID,
    "fk_usuario" UUID,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "limite_credito_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversacion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fk_familia" UUID,
    "tipo" BOOLEAN NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrantes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fk_conversacion" UUID NOT NULL,
    "fk_usuario" UUID NOT NULL,
    "rol" TEXT NOT NULL DEFAULT 'miembro',
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrantes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "familia_legacy_id_key" ON "familia"("legacy_id");

-- CreateIndex
CREATE INDEX "familia_fk_jefe_usuario_idx" ON "familia"("fk_jefe_usuario");

-- CreateIndex
CREATE UNIQUE INDEX "familia_usuario_legacy_id_key" ON "familia_usuario"("legacy_id");

-- CreateIndex
CREATE INDEX "familia_usuario_fk_usuario_idx" ON "familia_usuario"("fk_usuario");

-- CreateIndex
CREATE INDEX "familia_usuario_fk_familia_idx" ON "familia_usuario"("fk_familia");

-- CreateIndex
CREATE INDEX "limite_credito_fk_familia_idx" ON "limite_credito"("fk_familia");

-- CreateIndex
CREATE INDEX "limite_credito_fk_usuario_idx" ON "limite_credito"("fk_usuario");

-- CreateIndex
CREATE INDEX "conversacion_fk_familia_idx" ON "conversacion"("fk_familia");

-- CreateIndex
CREATE INDEX "integrantes_fk_conversacion_idx" ON "integrantes"("fk_conversacion");

-- CreateIndex
CREATE INDEX "integrantes_fk_usuario_idx" ON "integrantes"("fk_usuario");

-- CreateIndex
CREATE UNIQUE INDEX "integrantes_fk_usuario_fk_conversacion_key" ON "integrantes"("fk_usuario", "fk_conversacion");

-- AddForeignKey
ALTER TABLE "familia" ADD CONSTRAINT "familia_fk_jefe_usuario_fkey" FOREIGN KEY ("fk_jefe_usuario") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "familia_usuario" ADD CONSTRAINT "familia_usuario_fk_usuario_fkey" FOREIGN KEY ("fk_usuario") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "familia_usuario" ADD CONSTRAINT "familia_usuario_fk_familia_fkey" FOREIGN KEY ("fk_familia") REFERENCES "familia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "limite_credito" ADD CONSTRAINT "limite_credito_fk_familia_fkey" FOREIGN KEY ("fk_familia") REFERENCES "familia"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "limite_credito" ADD CONSTRAINT "limite_credito_fk_usuario_fkey" FOREIGN KEY ("fk_usuario") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversacion" ADD CONSTRAINT "conversacion_fk_familia_fkey" FOREIGN KEY ("fk_familia") REFERENCES "familia"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrantes" ADD CONSTRAINT "integrantes_fk_conversacion_fkey" FOREIGN KEY ("fk_conversacion") REFERENCES "conversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrantes" ADD CONSTRAINT "integrantes_fk_usuario_fkey" FOREIGN KEY ("fk_usuario") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- M-9 (Q-21): at most ONE ACTIVE membership per user — partial unique index; makes a
-- double-active state impossible at the DB level, concurrent-safe (F-09 reinforcement).
CREATE UNIQUE INDEX "familia_usuario_fk_usuario_activo_key" ON "familia_usuario"("fk_usuario") WHERE "estado" = true;

-- M-8 (Q-10): credit limit domain — monto >= 0 and EXACTLY ONE owner (familia XOR usuario).
ALTER TABLE "limite_credito" ADD CONSTRAINT "limite_credito_monto_no_negativo" CHECK ("monto" >= 0);
ALTER TABLE "limite_credito" ADD CONSTRAINT "limite_credito_propietario_unico" CHECK (((("fk_familia" IS NOT NULL)::int + ("fk_usuario" IS NOT NULL)::int)) = 1);

-- M-8: one limit row per owner (any estado; the upsert path reuses the row).
CREATE UNIQUE INDEX "limite_credito_fk_familia_key" ON "limite_credito"("fk_familia") WHERE "fk_familia" IS NOT NULL;
CREATE UNIQUE INDEX "limite_credito_fk_usuario_key" ON "limite_credito"("fk_usuario") WHERE "fk_usuario" IS NOT NULL;

-- M-9: one ACTIVE conversation per family (legacy partial-unique parity, database.md §4.2).
CREATE UNIQUE INDEX "conversacion_fk_familia_activa_key" ON "conversacion"("fk_familia") WHERE "estado" = true AND "fk_familia" IS NOT NULL;

-- M-9 (M-4): conversation membership rol domain (F-08).
ALTER TABLE "integrantes" ADD CONSTRAINT "integrantes_rol_dominio" CHECK ("rol" IN ('admin', 'miembro'));
