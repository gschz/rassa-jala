// Payment types catalog values — normative sources: docs/database.md M-13.
// Pure constants — shared by API, seed, and web client.

export const TIPO_PAGO = {
  EFECTIVO: "Efectivo",
  TRANSFERENCIA: "Transferencia",
  DEPOSITO: "Depósito",
} as const;

export type TipoPagoNombre = (typeof TIPO_PAGO)[keyof typeof TIPO_PAGO];
