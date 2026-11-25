// Order state catalog values — v2 REDUCED catalog (gap-pass-7 owner decision
// 2026-11-23, irreversible migration delete_estados_pedido_muertos): the legacy
// intermediate states en_preparacion/listo_para_retirar and the unused `activo` row
// (Q-18/D-4) are GONE — the legacy §9.2 enumeration is kept only as import
// archaeology in docs. Pure constants — no I/O; shared by the API, the seed and the
// web client (subpath import avoids pulling Prisma into the bundle).
//
// Legacy state machine reference (blueprints/pedido): SECUENCIA
// pendiente→confirmado→en_preparacion→listo_para_retirar→entregado — v2 collapses the
// two intermediate rows into `confirmado` (the last surviving pre-delivery state).
// ESTADOS_TERMINALES = {entregado, cancelado}; ESTADOS_CANCELABLES = everything
// before entregado.

export const ESTADO_PEDIDO = {
  PENDIENTE: "pendiente",
  CONFIRMADO: "confirmado",
  ENTREGADO: "entregado",
  CANCELADO: "cancelado",
} as const;
export type EstadoPedido = (typeof ESTADO_PEDIDO)[keyof typeof ESTADO_PEDIDO];

// Legacy ESTADOS_TERMINALES / ESTADOS_CANCELABLES (pedido/serializers.py:8-10), now on
// the reduced catalog: cancelable = any pre-delivery state.
export const ESTADOS_TERMINALES_PEDIDO = [
  ESTADO_PEDIDO.ENTREGADO,
  ESTADO_PEDIDO.CANCELADO,
] as const;
export const ESTADOS_CANCELABLES_PEDIDO = [
  ESTADO_PEDIDO.PENDIENTE,
  ESTADO_PEDIDO.CONFIRMADO,
] as const;

// Order origin (M-12): digital = client checkout (online or queued push); presencial =
// seller-created for an account-less person (fk_cliente NULL, no credit).
export const ORIGEN_PEDIDO = {
  DIGITAL: "digital",
  PRESENCIAL: "presencial",
} as const;
export type OrigenPedido = (typeof ORIGEN_PEDIDO)[keyof typeof ORIGEN_PEDIDO];
