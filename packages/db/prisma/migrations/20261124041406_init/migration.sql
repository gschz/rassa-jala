-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persona" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "apellido_paterno" TEXT NOT NULL,
    "apellido_materno" TEXT,
    "telefono" VARCHAR(20),
    "fecha_nacimiento" DATE,
    "sexo" VARCHAR(1),
    "domicilio" TEXT,
    "foto_key" TEXT,
    "foto_url" TEXT,
    "fk_localidad" UUID,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "persona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "correo" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "fk_persona" UUID NOT NULL,
    "fk_rol" UUID NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "debe_cambiar_password" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fk_usuario" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mensaje" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_conversacion" UUID NOT NULL,
    "fk_autor" UUID,
    "contenido" TEXT,
    "tipo" VARCHAR(10) NOT NULL DEFAULT 'texto',
    "archivo_url" TEXT,
    "leido" BOOLEAN NOT NULL DEFAULT false,
    "editado" BOOLEAN NOT NULL DEFAULT false,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mensaje_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documento" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "tipo_mime" TEXT NOT NULL,
    "tamano_bytes" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fk_autor" UUID,

    CONSTRAINT "documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corte" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_vendedor_id" UUID,
    "fecha" DATE NOT NULL,
    "monto_teorico" DECIMAL(12,2) NOT NULL,
    "monto_real" DECIMAL(12,2) NOT NULL,
    "diferencia" DECIMAL(12,2) NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'abierto',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corte_pkey" PRIMARY KEY ("id")
);

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
    "nombre" VARCHAR(100),
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

-- CreateTable
CREATE TABLE "liquidacion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_agricultor" UUID,
    "periodo_inicio" DATE NOT NULL,
    "periodo_fin" DATE NOT NULL,
    "monto_ventas" DECIMAL(12,2) NOT NULL,
    "tasa_comision" DECIMAL(5,4) NOT NULL DEFAULT 0.10,
    "comision" DECIMAL(12,2) NOT NULL,
    "monto_liquidar" DECIMAL(12,2) NOT NULL,
    "fk_pago_liquidacion" UUID,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liquidacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidacion_venta" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_liquidacion" UUID NOT NULL,
    "fk_pedido" UUID NOT NULL,
    "monto_aportado" DECIMAL(12,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liquidacion_venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_usuario" UUID,
    "accion" TEXT NOT NULL,
    "entidad" TEXT,
    "entidad_id" TEXT,
    "ip" VARCHAR(45) NOT NULL,
    "dispositivo" VARCHAR(200) NOT NULL,
    "detalle" JSONB,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_merma" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "decision" VARCHAR(50) NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_merma_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merma" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_producto_semanal" UUID,
    "cantidad" INTEGER NOT NULL,
    "motivo" VARCHAR(300) NOT NULL,
    "comentarios" TEXT,
    "fk_decision" UUID NOT NULL,
    "fk_pedido" UUID NOT NULL,
    "estado" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merma_pkey" PRIMARY KEY ("id")
);

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
    "fk_pedido" UUID,
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
    "folio" TEXT NOT NULL,
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
    "fk_producto" UUID,
    "fk_producto_semanal" UUID,
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

-- CreateTable
CREATE TABLE "recoleccion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_agricultor" UUID NOT NULL,
    "fecha_recoleccion" DATE NOT NULL,
    "hora_inicio" TIME,
    "hora_fin" TIME,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "comentarios" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recoleccion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historial_estado_recoleccion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legacy_id" INTEGER,
    "fk_recoleccion" UUID NOT NULL,
    "estado_anterior" TEXT,
    "estado_nuevo" TEXT NOT NULL,
    "fk_cambiado_por" UUID,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historial_estado_recoleccion_pkey" PRIMARY KEY ("id")
);

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
CREATE UNIQUE INDEX "roles_legacy_id_key" ON "roles"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_nombre_key" ON "roles"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "persona_legacy_id_key" ON "persona"("legacy_id");

-- CreateIndex
CREATE INDEX "persona_fk_localidad_idx" ON "persona"("fk_localidad");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_legacy_id_key" ON "usuario"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_correo_key" ON "usuario"("correo");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_fk_persona_key" ON "usuario"("fk_persona");

-- CreateIndex
CREATE INDEX "usuario_fk_rol_idx" ON "usuario"("fk_rol");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_fk_usuario_idx" ON "refresh_token"("fk_usuario");

-- CreateIndex
CREATE UNIQUE INDEX "mensaje_legacy_id_key" ON "mensaje"("legacy_id");

-- CreateIndex
CREATE INDEX "mensaje_fk_conversacion_creado_en_idx" ON "mensaje"("fk_conversacion", "creado_en");

-- CreateIndex
CREATE INDEX "mensaje_fk_autor_idx" ON "mensaje"("fk_autor");

-- CreateIndex
CREATE UNIQUE INDEX "documento_legacy_id_key" ON "documento"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "documento_storage_key_key" ON "documento"("storage_key");

-- CreateIndex
CREATE INDEX "documento_fk_autor_idx" ON "documento"("fk_autor");

-- CreateIndex
CREATE UNIQUE INDEX "corte_legacy_id_key" ON "corte"("legacy_id");

-- CreateIndex
CREATE INDEX "corte_fk_vendedor_id_idx" ON "corte"("fk_vendedor_id");

-- CreateIndex
CREATE INDEX "corte_fecha_idx" ON "corte"("fecha");

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

-- CreateIndex
CREATE UNIQUE INDEX "liquidacion_legacy_id_key" ON "liquidacion"("legacy_id");

-- CreateIndex
CREATE INDEX "liquidacion_fk_agricultor_idx" ON "liquidacion"("fk_agricultor");

-- CreateIndex
CREATE INDEX "liquidacion_estado_idx" ON "liquidacion"("estado");

-- CreateIndex
CREATE UNIQUE INDEX "unique_liquidacion_periodo" ON "liquidacion"("fk_agricultor", "periodo_inicio", "periodo_fin");

-- CreateIndex
CREATE UNIQUE INDEX "liquidacion_venta_legacy_id_key" ON "liquidacion_venta"("legacy_id");

-- CreateIndex
CREATE INDEX "liquidacion_venta_fk_liquidacion_idx" ON "liquidacion_venta"("fk_liquidacion");

-- CreateIndex
CREATE INDEX "liquidacion_venta_fk_pedido_idx" ON "liquidacion_venta"("fk_pedido");

-- CreateIndex
CREATE UNIQUE INDEX "unique_liquidacion_venta_pedido" ON "liquidacion_venta"("fk_liquidacion", "fk_pedido");

-- CreateIndex
CREATE UNIQUE INDEX "logs_legacy_id_key" ON "logs"("legacy_id");

-- CreateIndex
CREATE INDEX "logs_fk_usuario_idx" ON "logs"("fk_usuario");

-- CreateIndex
CREATE INDEX "logs_creado_en_idx" ON "logs"("creado_en" DESC);

-- CreateIndex
CREATE INDEX "logs_accion_idx" ON "logs"("accion");

-- CreateIndex
CREATE UNIQUE INDEX "decision_merma_legacy_id_key" ON "decision_merma"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "decision_merma_decision_key" ON "decision_merma"("decision");

-- CreateIndex
CREATE INDEX "decision_merma_estado_idx" ON "decision_merma"("estado");

-- CreateIndex
CREATE UNIQUE INDEX "merma_legacy_id_key" ON "merma"("legacy_id");

-- CreateIndex
CREATE INDEX "merma_fk_pedido_idx" ON "merma"("fk_pedido");

-- CreateIndex
CREATE INDEX "merma_fk_decision_idx" ON "merma"("fk_decision");

-- CreateIndex
CREATE INDEX "merma_fk_producto_semanal_idx" ON "merma"("fk_producto_semanal");

-- CreateIndex
CREATE INDEX "merma_creado_en_idx" ON "merma"("creado_en");

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

-- CreateIndex
CREATE UNIQUE INDEX "estado_pedido_legacy_id_key" ON "estado_pedido"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "estado_pedido_nombre_key" ON "estado_pedido"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "pedido_cabecera_legacy_id_key" ON "pedido_cabecera"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "pedido_cabecera_folio_key" ON "pedido_cabecera"("folio");

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

-- CreateIndex
CREATE INDEX "producto_imagen_fk_producto_semanal_idx" ON "producto_imagen"("fk_producto_semanal");

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
CREATE UNIQUE INDEX "recoleccion_legacy_id_key" ON "recoleccion"("legacy_id");

-- CreateIndex
CREATE INDEX "recoleccion_fk_agricultor_idx" ON "recoleccion"("fk_agricultor");

-- CreateIndex
CREATE INDEX "recoleccion_fecha_recoleccion_idx" ON "recoleccion"("fecha_recoleccion");

-- CreateIndex
CREATE UNIQUE INDEX "historial_estado_recoleccion_legacy_id_key" ON "historial_estado_recoleccion"("legacy_id");

-- CreateIndex
CREATE INDEX "historial_estado_recoleccion_fk_recoleccion_idx" ON "historial_estado_recoleccion"("fk_recoleccion");

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
ALTER TABLE "persona" ADD CONSTRAINT "persona_fk_localidad_fkey" FOREIGN KEY ("fk_localidad") REFERENCES "localidad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario" ADD CONSTRAINT "usuario_fk_persona_fkey" FOREIGN KEY ("fk_persona") REFERENCES "persona"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario" ADD CONSTRAINT "usuario_fk_rol_fkey" FOREIGN KEY ("fk_rol") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_fk_usuario_fkey" FOREIGN KEY ("fk_usuario") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensaje" ADD CONSTRAINT "mensaje_fk_conversacion_fkey" FOREIGN KEY ("fk_conversacion") REFERENCES "conversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensaje" ADD CONSTRAINT "mensaje_fk_autor_fkey" FOREIGN KEY ("fk_autor") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documento" ADD CONSTRAINT "documento_fk_autor_fkey" FOREIGN KEY ("fk_autor") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corte" ADD CONSTRAINT "corte_fk_vendedor_id_fkey" FOREIGN KEY ("fk_vendedor_id") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_fk_agricultor_fkey" FOREIGN KEY ("fk_agricultor") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_fk_pago_liquidacion_fkey" FOREIGN KEY ("fk_pago_liquidacion") REFERENCES "pago"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidacion_venta" ADD CONSTRAINT "liquidacion_venta_fk_liquidacion_fkey" FOREIGN KEY ("fk_liquidacion") REFERENCES "liquidacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidacion_venta" ADD CONSTRAINT "liquidacion_venta_fk_pedido_fkey" FOREIGN KEY ("fk_pedido") REFERENCES "pedido_cabecera"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs" ADD CONSTRAINT "logs_fk_usuario_fkey" FOREIGN KEY ("fk_usuario") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merma" ADD CONSTRAINT "merma_fk_producto_semanal_fkey" FOREIGN KEY ("fk_producto_semanal") REFERENCES "producto_semanal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merma" ADD CONSTRAINT "merma_fk_decision_fkey" FOREIGN KEY ("fk_decision") REFERENCES "decision_merma"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merma" ADD CONSTRAINT "merma_fk_pedido_fkey" FOREIGN KEY ("fk_pedido") REFERENCES "pedido_cabecera"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_fk_pedido_fkey" FOREIGN KEY ("fk_pedido") REFERENCES "pedido_cabecera"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_fk_tipo_pago_fkey" FOREIGN KEY ("fk_tipo_pago") REFERENCES "tipo_pago"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo" ADD CONSTRAINT "recibo_fk_pago_fkey" FOREIGN KEY ("fk_pago") REFERENCES "pago"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_fk_categoria_fkey" FOREIGN KEY ("fk_categoria") REFERENCES "categoria_producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_fk_unidad_fkey" FOREIGN KEY ("fk_unidad") REFERENCES "unidad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto_imagen" ADD CONSTRAINT "producto_imagen_fk_producto_fkey" FOREIGN KEY ("fk_producto") REFERENCES "producto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "recoleccion" ADD CONSTRAINT "recoleccion_fk_agricultor_fkey" FOREIGN KEY ("fk_agricultor") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_estado_recoleccion" ADD CONSTRAINT "historial_estado_recoleccion_fk_recoleccion_fkey" FOREIGN KEY ("fk_recoleccion") REFERENCES "recoleccion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_estado_recoleccion" ADD CONSTRAINT "historial_estado_recoleccion_fk_cambiado_por_fkey" FOREIGN KEY ("fk_cambiado_por") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "localidad" ADD CONSTRAINT "localidad_fk_municipio_fkey" FOREIGN KEY ("fk_municipio") REFERENCES "municipio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Business constraints & partial uniques ported from the per-domain migrations (collapsed init)
-- Prisma's DSL cannot express CHECK constraints or partial unique indexes
-- (database.md §5.2): every raw statement below is ported verbatim (final
-- version, data-only backfills excluded) from the collapsed per-domain
-- migrations. Constraint/index names are load-bearing: routers match P2002
-- against them (e.g. familia_usuario_fk_usuario_activo_key) and the e2e battery
-- pins them in pg_constraint/pg_indexes.

-- familias (add_familias_base)
CREATE UNIQUE INDEX "familia_usuario_fk_usuario_activo_key" ON "familia_usuario"("fk_usuario") WHERE "estado" = true;
ALTER TABLE "limite_credito" ADD CONSTRAINT "limite_credito_monto_no_negativo" CHECK ("monto" >= 0);
ALTER TABLE "limite_credito" ADD CONSTRAINT "limite_credito_propietario_unico" CHECK (((("fk_familia" IS NOT NULL)::int + ("fk_usuario" IS NOT NULL)::int)) = 1);
CREATE UNIQUE INDEX "limite_credito_fk_familia_key" ON "limite_credito"("fk_familia") WHERE "fk_familia" IS NOT NULL;
CREATE UNIQUE INDEX "limite_credito_fk_usuario_key" ON "limite_credito"("fk_usuario") WHERE "fk_usuario" IS NOT NULL;
CREATE UNIQUE INDEX "conversacion_fk_familia_activa_key" ON "conversacion"("fk_familia") WHERE "estado" = true AND "fk_familia" IS NOT NULL;
ALTER TABLE "integrantes" ADD CONSTRAINT "integrantes_rol_dominio" CHECK ("rol" IN ('admin', 'miembro'));

-- productos (add_productos_base)
CREATE UNIQUE INDEX "producto_imagen_principal_por_producto" ON "producto_imagen"("fk_producto") WHERE "principal" = true;
ALTER TABLE "producto_imagen" ADD CONSTRAINT "producto_imagen_orden_no_negativo" CHECK ("orden" >= 0);

-- publicaciones (add_publicaciones_base + ciclo_unico_libera_cancelado, final index version)
CREATE UNIQUE INDEX "producto_semanal_oferta_activa_unico" ON "producto_semanal"("fk_publicacion", "fk_producto") WHERE "estado" = 'activo';
ALTER TABLE "publicacion_semanal" ADD CONSTRAINT "publicacion_semanal_estado_dominio" CHECK ("estado" IN ('borrador', 'publicado', 'cancelado', 'cerrado'));
ALTER TABLE "producto_semanal" ADD CONSTRAINT "producto_semanal_estado_dominio" CHECK ("estado" IN ('activo', 'inactivo'));
ALTER TABLE "publicacion_semanal" ADD CONSTRAINT "publicacion_semanal_semana_iso_range" CHECK ("semana_iso" BETWEEN 1 AND 53);
ALTER TABLE "publicacion_semanal" ADD CONSTRAINT "publicacion_semanal_anio_iso_range" CHECK ("anio_iso" BETWEEN 2000 AND 2100);
ALTER TABLE "producto_semanal" ADD CONSTRAINT "producto_semanal_precio_no_negativo" CHECK ("precio" >= 0);
ALTER TABLE "producto_semanal" ADD CONSTRAINT "producto_semanal_stock_no_negativo" CHECK ("stock" >= 0);
ALTER TABLE "producto_imagen" ADD CONSTRAINT "producto_imagen_objetivo_unico" CHECK (((("fk_producto" IS NOT NULL))::int + ((("fk_producto_semanal") IS NOT NULL))::int) = 1);
CREATE UNIQUE INDEX "producto_imagen_principal_por_producto_semanal" ON "producto_imagen"("fk_producto_semanal") WHERE "fk_producto_semanal" IS NOT NULL AND "principal" = true;
CREATE UNIQUE INDEX "publicacion_semanal_agricultor_ciclo_unico" ON "publicacion_semanal"("fk_agricultor", "fecha_ciclo") WHERE "fk_agricultor" IS NOT NULL AND "estado" <> 'cancelado';

-- pedidos (add_pedidos_base)
ALTER TABLE "pedido_cabecera" ADD CONSTRAINT "pedido_cabecera_dinero_check" CHECK ("subtotal" >= 0 AND "iva" >= 0 AND "total" >= 0 AND "total" = "subtotal" + "iva");
ALTER TABLE "pedido_cabecera" ADD CONSTRAINT "pedido_cabecera_origen_check" CHECK ("origen" IN ('digital', 'presencial'));
ALTER TABLE "detalle_pedido" ADD CONSTRAINT "detalle_pedido_cantidad_check" CHECK ("cantidad" > 0);
ALTER TABLE "detalle_pedido" ADD CONSTRAINT "detalle_pedido_dinero_check" CHECK ("precio_unitario" >= 0 AND "importe" >= 0);

-- pagos (add_pagos_base; pago_fk_pedido_key full UNIQUE in the DDL above is
-- nulls-distinct by PG default — multiple fk_pedido NULL dispersion pagos legal)
ALTER TABLE "pago" ADD CONSTRAINT "pago_monto_positivo" CHECK ("monto" > 0);

-- recolecciones (add_recolecciones_base)
ALTER TABLE "recoleccion" ADD CONSTRAINT "recoleccion_estado_dominio" CHECK ("estado" IN ('pendiente', 'en_ruta', 'recolectado', 'cancelado'));
CREATE UNIQUE INDEX "uniq_recoleccion_activa_agricultor_fecha" ON "recoleccion"("fk_agricultor", "fecha_recoleccion") WHERE "estado" <> 'cancelado';

-- cortes (add_cortes_base)
ALTER TABLE "corte" ADD CONSTRAINT "corte_estado_dominio" CHECK ("estado" IN ('abierto', 'cerrado', 'cuadrado'));
ALTER TABLE "corte" ADD CONSTRAINT "corte_diferencia_snapshot" CHECK ("diferencia" = "monto_real" - "monto_teorico");
ALTER TABLE "corte" ADD CONSTRAINT "corte_monto_real_no_negativo" CHECK ("monto_real" >= 0);
CREATE UNIQUE INDEX "unique_corte_vendedor_fecha" ON "corte"("fk_vendedor_id", "fecha") WHERE "fk_vendedor_id" IS NOT NULL;

-- liquidaciones (add_liquidaciones_base)
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_estado_dominio" CHECK ("estado" IN ('pendiente', 'pagada', 'parcial'));
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_monto_snapshot" CHECK ("monto_liquidar" = "monto_ventas" - "comision");
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_montos_no_negativos" CHECK ("monto_ventas" >= 0 AND "comision" >= 0 AND "monto_liquidar" >= 0);
ALTER TABLE "liquidacion_venta" ADD CONSTRAINT "liquidacion_venta_monto_no_negativo" CHECK ("monto_aportado" >= 0);

-- mermas (add_mermas_base)
ALTER TABLE "merma" ADD CONSTRAINT "merma_cantidad_positiva" CHECK ("cantidad" > 0);

-- chat (add_chat_base + add_chat_adjuntos)
ALTER TABLE "mensaje" ADD CONSTRAINT "mensaje_contenido_no_vacia" CHECK (contenido IS NULL OR length(contenido) > 0);
ALTER TABLE "mensaje" ADD CONSTRAINT "mensaje_tipo_dominio" CHECK ("tipo" IN ('texto', 'audio', 'imagen', 'video'));

-- persona (add_persona_campos)
ALTER TABLE "persona" ADD CONSTRAINT "persona_sexo_dominio" CHECK ("sexo" IS NULL OR "sexo" IN ('M', 'F', 'O'));
