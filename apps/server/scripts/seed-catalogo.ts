// OPT-IN seed — catalog products with REAL images (D-1 storage adapter) for testing
// product cards, the RxDB `imagenes` collection, GET /storage/* and Supabase signed URLs.
//
// Source: dummyjson.com groceries (no API key). The title→Spanish map below is FIXED:
// a dummyjson item without a map entry (new upstream item) is skipped with a notice,
// never invented. Downloads go through the SAME storage drivers the server uses
// (apps/server/src/services/storage.ts) — the producto_imagen row stores the driver's
// storageKey + url, never an external URL.
//
// M-1a (NON-NEGOTIABLE): per product, ONE transaction writes producto + producto_imagen
// + their sync_cambio rows (operacion insert, tablaOrigen 'producto'/'producto_imagen',
// actor 'seed-catalogo') — without the outbox rows the PULL never sees the rows.
//
// Idempotency by nombre: a product that already exists is skipped (second run creates
// nothing and stores no duplicate images/files).
//
// Usage: bun scripts/seed-catalogo.ts [--apply]
//   (no flag) : print the would-be plan, write nothing (no downloads either)
//   --apply   : download images, save through the driver, write rows

import { createPrismaClient } from "@rassa-jala/db";
import type { Prisma } from "@rassa-jala/db";

import { ENV } from "../src/env.server";
import { createStorageDriver } from "../src/services/storage";

const ACTOR = "seed-catalogo";
const FETCH_URL =
  "https://dummyjson.com/products/category/groceries?select=title,description,thumbnail,images";
const DOWNLOAD_TIMEOUT_MS = 10_000;
// Global fallback category (the most generic of the seeded set: the API's groceries span
// produce, meat, dairy and pantry goods and there is no "Carnes"/"Abarrotes" category).
const CATEGORIA_FALLBACK = "Granos";

// Fixed title → { nombre, categoria, unidad, descripcion }. `categoria` is a preferred
// category NAME resolved against the live categoria_producto rows (the dev DB holds more
// categories than the seed: Lácteos, Tubérculos…); when it is absent the fallback applies.
// `unidad` is a preferred unidad NAME (nullable, like the column); absent at runtime → null.
const NOMBRES_ES = {
  Apple: {
    nombre: "Manzana",
    categoria: "Frutas",
    unidad: "Kilogramo",
    descripcion: "Manzana fresca de mesa",
  },
  "Beef Steak": {
    nombre: "Bistec de res",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Kilogramo",
    descripcion: "Bistec de res fresco para asar o cocinar",
  },
  "Cat Food": {
    nombre: "Alimento para gato",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Kilogramo",
    descripcion: "Alimento balanceado para gato",
  },
  "Chicken Meat": {
    nombre: "Pechuga de pollo",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Kilogramo",
    descripcion: "Pollo fresco para guisos y asados",
  },
  "Cooking Oil": {
    nombre: "Aceite vegetal",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Litro",
    descripcion: "Aceite vegetal para cocinar",
  },
  Cucumber: {
    nombre: "Pepino",
    categoria: "Verduras",
    unidad: "Kilogramo",
    descripcion: "Pepino fresco para ensaladas",
  },
  "Dog Food": {
    nombre: "Alimento para perro",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Kilogramo",
    descripcion: "Alimento balanceado para perro",
  },
  Eggs: {
    nombre: "Huevos",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Docena",
    descripcion: "Huevos blancos frescos",
  },
  "Fish Steak": {
    nombre: "Filete de pescado",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Kilogramo",
    descripcion: "Filete de pescado para preparar al gusto",
  },
  "Green Bell Pepper": {
    nombre: "Pimiento verde",
    categoria: "Verduras",
    unidad: "Kilogramo",
    descripcion: "Pimiento morrón verde fresco",
  },
  "Green Chili Pepper": {
    nombre: "Chile verde",
    categoria: "Verduras",
    unidad: "Kilogramo",
    descripcion: "Chile verde fresco",
  },
  "Honey Jar": {
    nombre: "Miel de abeja",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Pieza",
    descripcion: "Miel de abeja pura en pote",
  },
  "Ice Cream": {
    nombre: "Helado",
    categoria: "Lácteos",
    unidad: "Pieza",
    descripcion: "Helado cremoso",
  },
  Juice: {
    nombre: "Jugo de frutas",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Pieza",
    descripcion: "Jugo embotellado",
  },
  Kiwi: {
    nombre: "Kiwi",
    categoria: "Frutas",
    unidad: "Kilogramo",
    descripcion: "Kiwi fresco",
  },
  Lemon: {
    nombre: "Limón",
    categoria: "Frutas",
    unidad: "Kilogramo",
    descripcion: "Limón fresco",
  },
  Milk: {
    nombre: "Leche",
    categoria: "Lácteos",
    unidad: "Litro",
    descripcion: "Leche entera pasteurizada",
  },
  Mulberry: {
    nombre: "Mora",
    categoria: "Frutas",
    unidad: "Kilogramo",
    descripcion: "Mora fresca",
  },
  "Nescafe Coffee": {
    nombre: "Café soluble",
    categoria: "Granos",
    unidad: "Pieza",
    descripcion: "Café soluble en frasco",
  },
  Potatoes: {
    nombre: "Papa",
    categoria: "Tubérculos",
    unidad: "Kilogramo",
    descripcion: "Papa de mesa",
  },
  "Protein Powder": {
    nombre: "Proteína en polvo",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Pieza",
    descripcion: "Proteína en polvo",
  },
  "Red Onions": {
    nombre: "Cebolla morada",
    categoria: "Verduras",
    unidad: "Kilogramo",
    descripcion: "Cebolla morada",
  },
  Rice: {
    nombre: "Arroz",
    categoria: "Granos",
    unidad: "Kilogramo",
    descripcion: "Arroz blanco de grano largo",
  },
  "Soft Drinks": {
    nombre: "Refresco",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Pieza",
    descripcion: "Refresco embotellado",
  },
  Strawberry: {
    nombre: "Fresa",
    categoria: "Frutas",
    unidad: "Kilogramo",
    descripcion: "Fresa fresca",
  },
  "Tissue Paper Box": {
    nombre: "Pañuelos desechables",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Pieza",
    descripcion: "Caja de pañuelos desechables",
  },
  Water: {
    nombre: "Agua embotellada",
    categoria: CATEGORIA_FALLBACK,
    unidad: "Pieza",
    descripcion: "Agua purificada embotellada",
  },
} as const satisfies Record<
  string,
  {
    nombre: string;
    categoria: string;
    unidad: string | null;
    descripcion: string;
  }
>;

// Only the extensions the API actually serves and MIME_PERMITIDOS (productos.ts) allows.
const EXTENSIONES_PERMITIDAS = new Set(["png", "jpg", "jpeg", "webp"]);

interface ItemApi {
  title: string;
  thumbnail?: string;
  images?: string[];
}

interface PlanProducto {
  title: string;
  nombre: string;
  descripcion: string;
  categoria: string;
  unidad: string | null;
  imagenUrl: string;
}

type Tx = Prisma.TransactionClient;

async function registrarCambio(tx: Tx, tablaOrigen: string, idFila: string): Promise<void> {
  await tx.syncCambio.create({
    data: { tablaOrigen, idFila, operacion: "insert", actor: ACTOR },
  });
}

function extensionDe(url: string): string | null {
  const ultimo = url.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSIONES_PERMITIDAS.has(ultimo) ? (ultimo === "jpeg" ? "jpg" : ultimo) : null;
}

async function descargarImagen(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const db = createPrismaClient({ DATABASE_URL: ENV.DATABASE_URL });
  const driver = createStorageDriver();

  // --- source list (a network drop here yields an empty run, never a crash) ---
  let items: ItemApi[] = [];
  try {
    const res = await fetch(FETCH_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items = ((await res.json()) as { products?: ItemApi[] }).products ?? [];
  } catch (error) {
    console.warn(`aviso: la lista de dummyjson no está disponible (${String(error)}); 0 productos`);
  }

  // --- resolve lookups against the LIVE catalogs (more categories than the seed) ---
  const [categoriasDb, unidadesDb, nombresExistentes] = await Promise.all([
    db.categoriaProducto.findMany({ select: { nombre: true, id: true } }),
    db.unidad.findMany({ select: { nombre: true, id: true } }),
    db.producto.findMany({
      select: { nombre: true },
      where: { nombre: { in: Object.values(NOMBRES_ES).map((n) => n.nombre) } },
    }),
  ]);
  const categoriaPorNombre = new Map(categoriasDb.map((c) => [c.nombre, c.id]));
  const unidadPorNombre = new Map(unidadesDb.map((u) => [u.nombre, u.id]));
  const yaExisten = new Set(nombresExistentes.map((p) => p.nombre));

  // --- plan (same shape for preview and apply; existence check runs first) ---
  const plan: PlanProducto[] = [];
  let omitidosExistentes = 0;
  for (const item of items) {
    const mapeo = NOMBRES_ES[item.title as keyof typeof NOMBRES_ES];
    if (!mapeo) {
      console.warn(`aviso: item sin mapeo de nombre, se omite: "${item.title}"`);
      continue;
    }
    if (yaExisten.has(mapeo.nombre)) {
      omitidosExistentes++;
      continue;
    }
    const fkCategoria =
      categoriaPorNombre.get(mapeo.categoria) ?? categoriaPorNombre.get(CATEGORIA_FALLBACK);
    if (!fkCategoria) {
      console.warn(
        `aviso: sin categoría "${mapeo.categoria}" ni fallback, se omite: "${mapeo.nombre}"`,
      );
      continue;
    }
    const imagenUrl = item.images?.[0] ?? item.thumbnail;
    if (!imagenUrl || !extensionDe(imagenUrl)) {
      console.warn(`aviso: item sin imagen utilizable, se omite: "${mapeo.nombre}"`);
      continue;
    }
    plan.push({
      title: item.title,
      nombre: mapeo.nombre,
      descripcion: mapeo.descripcion,
      categoria: mapeo.categoria,
      unidad: mapeo.unidad && unidadPorNombre.has(mapeo.unidad) ? mapeo.unidad : null,
      imagenUrl,
    });
  }

  console.log(`\n--- PLAN (dummyjson groceries: ${items.length} items) ---`);
  for (const p of plan) {
    console.log(`  ${p.nombre} ← "${p.title}" [${p.categoria}${p.unidad ? ` / ${p.unidad}` : ""}]`);
    console.log(`    imagen: ${p.imagenUrl}`);
  }
  console.log(`crearía: ${plan.length} productos (+1 imagen y +2 sync_cambio c/u)`);
  console.log(`omitidos por existir (idempotencia por nombre): ${omitidosExistentes}`);

  if (!apply) {
    console.log("\nPREVIEW: nada escrito. Usa --apply para escribir.");
    await db.$disconnect();
    return;
  }

  // --- apply: per item download → driver.save → ONE tx (producto + imagen + 2 outbox) ---
  const counts = { productos: 0, imagenes: 0, cambios: 0, fallidos: 0 };
  for (const p of plan) {
    const bytes = await descargarImagen(p.imagenUrl);
    if (!bytes) {
      console.warn(`aviso: descarga falló, se omite: "${p.nombre}" (${p.imagenUrl})`);
      counts.fallidos++;
      continue;
    }
    const ext = extensionDe(p.imagenUrl);
    if (!ext) {
      console.warn(`aviso: extensión no permitida, se omite: "${p.nombre}"`);
      counts.fallidos++;
      continue;
    }
    const fkCategoria =
      categoriaPorNombre.get(p.categoria) ?? categoriaPorNombre.get(CATEGORIA_FALLBACK);
    if (!fkCategoria) {
      console.warn(`aviso: sin categoría al aplicar, se omite: "${p.nombre}"`);
      counts.fallidos++;
      continue;
    }
    const fkUnidad = p.unidad ? (unidadPorNombre.get(p.unidad) ?? null) : null;
    try {
      // Adapter write OUTSIDE the tx (router pattern): store first, then the tx commits
      // rows + outbox atomically; on tx failure the file is removed (best-effort).
      const guardado = await driver.save(bytes, ext);
      try {
        await db.$transaction(
          async (tx) => {
            // Re-check inside the tx: a concurrent writer with the same nombre wins, we skip.
            if (
              await tx.producto.findFirst({ where: { nombre: p.nombre }, select: { id: true } })
            ) {
              omitidosExistentes++;
              await driver.remove(guardado.storageKey);
              return;
            }
            const producto = await tx.producto.create({
              data: {
                nombre: p.nombre,
                descripcion: p.descripcion,
                fkCategoria,
                fkUnidad,
              },
            });
            await registrarCambio(tx, "producto", producto.id);
            // First image of the product → orden 0 + principal (same rule as productos.ts).
            const imagen = await tx.productoImagen.create({
              data: {
                fkProducto: producto.id,
                storageKey: guardado.storageKey,
                url: guardado.url,
                orden: 0,
                principal: true,
              },
            });
            await registrarCambio(tx, "producto_imagen", imagen.id);
            counts.productos++;
            counts.imagenes++;
            counts.cambios += 2;
          },
          { timeout: 60_000, maxWait: 15_000 },
        );
        console.log(`creado: ${p.nombre} → ${guardado.storageKey}`);
      } catch (error) {
        await driver.remove(guardado.storageKey);
        throw error;
      }
    } catch (error) {
      console.warn(`aviso: no se pudo crear "${p.nombre}": ${String(error)}`);
      counts.fallidos++;
    }
  }

  console.log(
    `\nHecho: productos=${counts.productos} imágenes=${counts.imagenes} sync_cambio=${counts.cambios} ` +
      `omitidosexistentes=${omitidosExistentes} fallidos=${counts.fallidos}`,
  );
  console.log("Corre de nuevo → productos=0 (idempotente por nombre).");
  await db.$disconnect();
}

main().catch((error) => {
  console.error("seed-catalogo failed:", error);
  process.exit(1);
});
