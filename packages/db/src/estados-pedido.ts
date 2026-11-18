// Order state catalog values — EXACT legacy seed strings (docs/01-audit/database-audit.md
// §9.2 table-enumerations: pendiente, confirmado, en_preparacion, listo_para_retirar,
// entregado, cancelado, activo). The `activo` row (legacy id 7) is seeded for Q-18/D-4
// parity but referenced by no state machine. Pure constants — no I/O; shared by the API,
// the seed and the web client (subpath import avoids pulling Prisma into the bundle).
//
// Legacy state machine reference (blueprints/pedido): SECUENCIA
// pendiente→confirmado→en_preparacion→listo_para_retirar→entregado; ESTADOS_TERMINALES =
// {entregado, cancelado}; ESTADOS_CANCELABLES = everything before entregado.

export const ESTADO_PEDIDO = {
  PENDIENTE: "pendiente",
  CONFIRMADO: "confirmado",
  EN_PREPARACION: "en_preparacion",
  LISTO_PARA_RETIRAR: "listo_para_retirar",
  ENTREGADO: "entregado",
  CANCELADO: "cancelado",
  // Legacy row, unused by any flow (Q-18 — D-4 still open: conservar/usar/eliminar).
  ACTIVO: "activo",
} as const;
export type EstadoPedido = (typeof ESTADO_PEDIDO)[keyof typeof ESTADO_PEDIDO];

// Legacy ESTADOS_TERMINALES / ESTADOS_CANCELABLES (pedido/serializers.py:8-10).
export const ESTADOS_TERMINALES_PEDIDO = [
  ESTADO_PEDIDO.ENTREGADO,
  ESTADO_PEDIDO.CANCELADO,
] as const;
export const ESTADOS_CANCELABLES_PEDIDO = [
  ESTADO_PEDIDO.PENDIENTE,
  ESTADO_PEDIDO.CONFIRMADO,
  ESTADO_PEDIDO.EN_PREPARACION,
  ESTADO_PEDIDO.LISTO_PARA_RETIRAR,
] as const;

// Order origin (M-12): digital = client checkout (online or queued push); presencial =
// seller-created for an account-less person (fk_cliente NULL, no credit).
export const ORIGEN_PEDIDO = {
  DIGITAL: "digital",
  PRESENCIAL: "presencial",
} as const;
export type OrigenPedido = (typeof ORIGEN_PEDIDO)[keyof typeof ORIGEN_PEDIDO];
