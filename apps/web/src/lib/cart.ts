// Cart (P0 Pedidos) — LOCAL RxDB operations + display-only estimates.
// The money math reuses the API's money helper (integer cents, Q-14); the totals it
// produces on the client are DISPLAY-ONLY ("estimado") — the server snapshot is the only
// authority (docs/scope.md §6: nothing pending is ever presented as confirmed).
import {
  aCentavos,
  aDecimal,
  importeDe,
  ivaDe,
  sumaCentavos,
  totalDe,
} from "@rassa-jala/api/money";

import type { CarritoDoc, ItemSemanalDoc, RassaDatabase } from "./rxdb/database";

/** Add (or bump) a cart line, capped by the offer's stock. */
export async function agregarAlCarrito(
  db: RassaDatabase,
  item: ItemSemanalDoc,
  nombre: string,
  cantidad = 1,
): Promise<void> {
  const existente = await db.carrito.findOne(item.id).exec();
  if (existente) {
    const nueva = Math.min(existente.cantidad + cantidad, Math.max(item.stock, 1));
    await existente.incrementalPatch({ cantidad: nueva, stock: item.stock, precio: item.precio });
    return;
  }
  if (item.stock <= 0) return;
  await db.carrito.insert({
    id: item.id,
    fkProductoSemanal: item.id,
    nombre,
    precio: item.precio,
    cantidad: Math.min(cantidad, item.stock),
    stock: item.stock,
    agregadoEn: new Date().toISOString(),
  });
}

/** Set a line quantity (1..stock); remove the line below 1. */
export async function cambiarCantidad(
  db: RassaDatabase,
  fkProductoSemanal: string,
  cantidad: number,
): Promise<void> {
  const linea = await db.carrito.findOne(fkProductoSemanal).exec();
  if (!linea) return;
  if (cantidad <= 0) {
    await linea.remove();
    return;
  }
  await linea.incrementalPatch({ cantidad: Math.min(cantidad, linea.stock) });
}

export async function vaciarCarrito(db: RassaDatabase): Promise<void> {
  await db.carrito.find().remove();
}

export function lineasDelCarrito(docs: CarritoDoc[]): CarritoDoc[] {
  return [...docs].sort((a, b) => a.agregadoEn.localeCompare(b.agregadoEn));
}

/**
 * Display-only estimate (integer cents, exact). Label it "estimado" in the UI — the
 * server adjudication recomputes every snapshot from its own data.
 */
export function estimadoDe(lineas: CarritoDoc[]): { subtotal: string; iva: string; total: string } {
  const subtotalCents = sumaCentavos(lineas.map((l) => importeDe(aCentavos(l.precio), l.cantidad)));
  const ivaCents = ivaDe(subtotalCents);
  const totalCents = totalDe(subtotalCents, ivaCents);
  return {
    subtotal: aDecimal(subtotalCents),
    iva: aDecimal(ivaCents),
    total: aDecimal(totalCents),
  };
}
