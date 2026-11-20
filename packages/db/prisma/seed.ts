// DEV SEED — Nayarit sample data for the vertical slice (PULL demo data).
// Idempotent: fixed UUIDs + guarded inserts; every seeded row writes its sync_cambio row in the
// same transaction (M-1a) so the PULL checkpoint sees it. Run with: bun prisma/seed.ts

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/client";
import type { Prisma } from "./generated/client";
import {
  ESTADO_ITEM_SEMANAL,
  ESTADO_PUBLICACION,
  aFechaCiclo,
  isoWeekFromMonday,
  mondayOfBusinessWeek,
} from "../src/iso-semana";
import { ESTADO_PEDIDO } from "../src/estados-pedido";
import { TIPO_PAGO } from "../src/tipos-pago";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

type Tx = Prisma.TransactionClient;

const MUNICIPIOS = [
  { id: "4799566a-ecfc-4433-a071-04b0b2dcd675", nombre: "Tepic" },
  { id: "109dc108-4fe3-44fb-8c24-9072ff34a0fa", nombre: "Xalisco" },
  { id: "47012d0a-63d1-4671-b4a4-8c58f99db5e2", nombre: "Compostela" },
  { id: "c23a107f-0706-4f48-8691-0fcadfc211ed", nombre: "Bahía de Banderas" },
  { id: "1b245a98-300b-4f08-9866-360fe9230ac4", nombre: "San Blas" },
] as const;

const LOCALIDADES = [
  {
    id: "08f1702e-7179-4e9d-99d7-1058959b1199",
    nombre: "Tepic",
    municipio: "Tepic",
  },
  {
    id: "2ffe01fa-c76c-4f00-bb47-d1fd58b38adc",
    nombre: "Bellavista",
    municipio: "Tepic",
  },
  {
    id: "8b514f7c-e3d9-4e52-9721-ccb50ef9644e",
    nombre: "Xalisco",
    municipio: "Xalisco",
  },
  {
    id: "2fcb8fed-322f-46b3-94a3-97d6227a903f",
    nombre: "San Cayetano",
    municipio: "Xalisco",
  },
  {
    id: "6b346c06-944e-4a3f-af41-654b3e58d0be",
    nombre: "Compostela",
    municipio: "Compostela",
  },
  {
    id: "84e548fd-fab7-41c3-a313-99f4edd1f87f",
    nombre: "Las Varas",
    municipio: "Compostela",
  },
  {
    id: "1def794e-25a8-4014-9aba-e9e3a6085295",
    nombre: "San Vicente",
    municipio: "Bahía de Banderas",
  },
  {
    id: "3f695ed2-e3eb-4c54-b343-ffce4e346515",
    nombre: "Bucerías",
    municipio: "Bahía de Banderas",
  },
  {
    id: "931692a6-4756-4f75-9bfb-322cda58b8fb",
    nombre: "San Blas",
    municipio: "San Blas",
  },
  {
    id: "c6b2746f-e32f-4824-b18a-6b4f9a520540",
    nombre: "Aticama",
    municipio: "San Blas",
  },
] as const;

const CATEGORIAS = [
  { id: "e4a6fddb-fdf8-4507-b8ec-6525301e9b9d", nombre: "Verduras" },
  { id: "d22de29e-b78a-41b0-a8ac-9abf635290ef", nombre: "Frutas" },
  { id: "c15e7206-ea65-4bc8-bd30-ca533761e9b2", nombre: "Hierbas" },
  { id: "2ece516d-c359-4592-b223-76830fe4eb1a", nombre: "Granos" },
] as const;

const UNIDADES = [
  {
    id: "ea92dbf4-988c-430f-9b80-be5d33cc27d6",
    tipo: "peso",
    nombre: "Kilogramo",
    abreviatura: "kg",
  },
  {
    id: "511bf7a4-61bd-43b6-8ed1-31e6b9aebf9f",
    tipo: "unidad",
    nombre: "Pieza",
    abreviatura: "pz",
  },
  {
    id: "2f6413bb-263d-430f-9b9c-c25401dd568b",
    tipo: "unidad",
    nombre: "Atado",
    abreviatura: "at",
  },
] as const;

// Productos module seed (P0): master-catalog samples reusing the fixed categoria/unidad
// ids above (idempotent by fixed ids + guarded inserts). Images are NOT seeded — they are
// uploaded through the storage adapter (D-1) from the admin page.
const PRODUCTOS = [
  {
    id: "a1000000-0000-4000-8000-000000000001",
    nombre: "Tomate",
    descripcion: "Tomate saladette de meseta",
    categoria: "Verduras",
    unidad: "Kilogramo",
  },
  {
    id: "a1000000-0000-4000-8000-000000000002",
    nombre: "Chile Serrano",
    descripcion: null,
    categoria: "Verduras",
    unidad: "Kilogramo",
  },
  {
    id: "a1000000-0000-4000-8000-000000000003",
    nombre: "Mango",
    descripcion: "Mango Ataulfo",
    categoria: "Frutas",
    unidad: "Kilogramo",
  },
  {
    id: "a1000000-0000-4000-8000-000000000004",
    nombre: "Cilantro",
    descripcion: null,
    categoria: "Hierbas",
    unidad: "Atado",
  },
  {
    id: "a1000000-0000-4000-8000-000000000005",
    nombre: "Frijol",
    descripcion: "Frijol negro" as string | null,
    categoria: "Granos",
    unidad: null,
  },
  {
    id: "a1000000-0000-4000-8000-000000000006",
    nombre: "Papaya",
    descripcion: null,
    categoria: "Frutas",
    unidad: "Pieza",
  },
] as const;

// Data-driven roles (backend-audit §2.1): the four legacy rows, Spanish names as canonical
// (F-26 — the DB holds the Spanish strings).
const ROLES = [
  { id: "37e142f3-8256-47fb-bc94-056e6e7bfbb7", nombre: "Admin" },
  { id: "f9336c97-5bc5-48c6-a76c-af25c62a7a7e", nombre: "Agricultor" },
  { id: "f2ec4fa4-5ea2-4edf-942f-66fe885a68b1", nombre: "Vendedor" },
  { id: "71348f96-7835-4d65-b44e-343f507f1bbe", nombre: "Cliente" },
] as const;

// Dev login users. Passwords are only ever hashed here (never printed).
const ADMIN_ID = "aa286d14-7060-46ed-a1ca-d978ee4974b7";
const ADMIN_PERSONA_ID = "08c34989-d67c-4f5e-89f4-c9d93a519378";
const BLOQUEADO_ID = "25ea618b-5e71-4d76-9a5f-11ec21fb7f2b";
const BLOQUEADO_PERSONA_ID = "4fa730b1-e705-4620-a881-3f07ccf09254";
// Active non-admin user: proves the Admin-only push role check (legacy IsAdminOrReadOnly).
const AGRICULTOR_ID = "5c2fa9c1-8e6f-4b0e-9f38-7a1d5c4e2b90";
const AGRICULTOR_PERSONA_ID = "9d3e77aa-2f6c-4c58-b1e4-0a8f5d6e7c21";
// Second Agricultor (role-change proof target for the P0 Usuarios module).
const AGRICULTOR2_ID = "6d3fb0d2-9f40-4c21-8e49-8b2d7f5a3c01";
const AGRICULTOR2_PERSONA_ID = "7e4ac1e3-0a51-4d32-9f5a-9c3e8a6b4d12";
// Second family member (jefe) + standalone client with an individual credit limit.
const VENDEDOR_ID = "8b7e2f61-4c93-4a1e-9d47-3f6a2c8b5d10";
const VENDEDOR_PERSONA_ID = "c1d4a8f2-6b35-4e97-8a20-5d9c7e4b3f11";
const CLIENTE_ID = "3e9a6c28-7d51-4b83-a2f4-9c1b8e5d7a46";
const CLIENTE_PERSONA_ID = "f2a8d3c5-1e97-4b62-8d30-7c5a9e1b4d82";
const DEV_PASSWORD = "RassaDev2026!";

// Familias module seed (P0): one sample family (jefe = agricultor + vendedor member)
// with its family credit limit and group conversation, plus a standalone client with an
// individual limit. Fixed ids keep the seed idempotent.
const FAMILIA_ID = "a1f2b3c4-5d6e-4f70-8a91-b2c3d4e5f607";
const FAMILIA_CONVERSACION_ID = "b2c3d4e5-f607-4a81-9b2c-3d4e5f607a18";
const LIMITE_FAMILIA_ID = "c3d4e5f6-07a1-84b2-9c3d-4e5f607a18b2";
const LIMITE_CLIENTE_ID = "d4e5f607-a18b-24c3-9d4e-5f607a18b2c3";
const MEMBRESIA_AGRICULTOR_ID = "e5f607a1-8b2c-4d3e-9f46-07a18b2c3d4e";
const MEMBRESIA_VENDEDOR_ID = "f607a18b-2c3d-4e5f-807a-18b2c3d4e5f6";

// Publicaciones module seed (P0): one PUBLISHED publication for the CURRENT ciclo
// (this week's Monday, computed at seed time) owned by the Agricultor seed user, with
// three active items reusing the master catalog ids above. Fixed ids + the seed()
// guard keep it idempotent (re-running within the same week is a no-op; once the week
// changes the new ciclo starts empty — farmers create their new drafts in the app).
// Images are NOT seeded (storage-adapter uploads are an app flow).
const PUBLICACION_ID = "b7c9d2e4-5f60-4a81-9b2c-3d4e5f607a19";
const ITEMS_SEMANALES = [
  { id: "c8d0e3f5-6071-4b92-8c3d-4e5f607a19b3", producto: "Tomate", precio: "32.50", stock: 40 },
  {
    id: "d9e1f406-7182-4ca3-9d4e-5f607a19b3c4",
    producto: "Chile Serrano",
    precio: "45.00",
    stock: 25,
  },
  { id: "eaf20517-8293-4db4-8e5f-607a19b3c4d5", producto: "Mango", precio: "28.00", stock: 30 },
] as const;

// Pedidos module seed (P0): estado_pedido lookup EXACTLY as the legacy seed values
// (docs/01-audit/database-audit.md §9.2: pendiente, confirmado, en_preparacion,
// listo_para_retirar, entregado, cancelado, activo). `activo` (legacy id 7) is seeded
// verbatim for Q-18/D-4 parity — no state machine references it. Idempotent by UNIQUE
// nombre lookup (upsert), not by fixed id, so re-runs and legacy imports converge.
const ESTADOS_PEDIDO = [
  { nombre: ESTADO_PEDIDO.PENDIENTE, orden: 1 },
  { nombre: ESTADO_PEDIDO.CONFIRMADO, orden: 2 },
  { nombre: ESTADO_PEDIDO.EN_PREPARACION, orden: 3 },
  { nombre: ESTADO_PEDIDO.LISTO_PARA_RETIRAR, orden: 4 },
  { nombre: ESTADO_PEDIDO.ENTREGADO, orden: 5 },
  { nombre: ESTADO_PEDIDO.CANCELADO, orden: 6 },
  { nombre: ESTADO_PEDIDO.ACTIVO, orden: 7 },
] as const;

// Pagos module seed (P0): tipo_pago lookup (M-13)
const TIPOS_PAGO = [
  { nombre: TIPO_PAGO.EFECTIVO },
  { nombre: TIPO_PAGO.TRANSFERENCIA },
  { nombre: TIPO_PAGO.DEPOSITO },
] as const;

// Insert the business row and its outbox row together; skip both when already seeded.
async function seed(
  tx: Tx,
  tabla: string,
  id: string,
  crear: () => Promise<unknown>,
): Promise<void> {
  const yaRegistrado = await tx.syncCambio.findFirst({
    where: { tablaOrigen: tabla, idFila: id },
  });
  if (yaRegistrado) return;
  await crear();
  await tx.syncCambio.create({
    data: {
      tablaOrigen: tabla,
      idFila: id,
      operacion: "insert",
      actor: "dev-seed",
    },
  });
}

async function main(): Promise<void> {
  // Current ciclo Monday (computed once; the publication seed targets this week).
  const lunesCiclo = mondayOfBusinessWeek(new Date());
  const { semanaIso, anioIso } = isoWeekFromMonday(lunesCiclo);
  await db.$transaction(async (tx) => {
    // ---- Pedidos module (P0): estado_pedido catalog (idempotent by UNIQUE nombre) ----
    // Upsert-by-name: a re-run updates orden only; a legacy import with different UUIDs
    // still converges because the lookup key is the state NAME. The outbox row (seed)
    // is what makes the S1 `estadosPedido` PULL deliverable (the outbox is THE
    // change-delivery channel; a catalog row without one stays invisible to clients).
    for (const estado of ESTADOS_PEDIDO) {
      const fila = await tx.estadoPedido.upsert({
        where: { nombre: estado.nombre },
        update: { orden: estado.orden },
        create: { nombre: estado.nombre, orden: estado.orden },
      });
      await seed(tx, "estado_pedido", fila.id, () => Promise.resolve());
    }

    // ---- Pagos module (P0): tipo_pago catalog + folio secuencias (M-13) ----
    for (const tipo of TIPOS_PAGO) {
      const fila = await tx.tipoPago.upsert({
        where: { nombre: tipo.nombre },
        update: {},
        create: { nombre: tipo.nombre },
      });
      await seed(tx, "tipo_pago", fila.id, () => Promise.resolve());
    }
    await tx.folioSecuencia.upsert({
      where: { nombre: "pago" },
      update: {},
      create: { nombre: "pago", siguiente: 1 },
    });
    await tx.folioSecuencia.upsert({
      where: { nombre: "recibo" },
      update: {},
      create: { nombre: "recibo", siguiente: 1 },
    });

    const idsMunicipio = new Map(MUNICIPIOS.map((m) => [m.nombre, m.id]));

    await Promise.all(
      MUNICIPIOS.map((m) =>
        seed(tx, "municipio", m.id, () =>
          tx.municipio.create({ data: { id: m.id, nombre: m.nombre } }),
        ),
      ),
    );

    await Promise.all(
      LOCALIDADES.map((l) => {
        const fkMunicipio = idsMunicipio.get(l.municipio);
        if (!fkMunicipio) throw new Error(`Municipio desconocido en seed: ${l.municipio}`);
        return seed(tx, "localidad", l.id, () =>
          tx.localidad.create({
            data: { id: l.id, fkMunicipio, nombre: l.nombre },
          }),
        );
      }),
    );

    await Promise.all(
      CATEGORIAS.map((c) =>
        seed(tx, "categoria_producto", c.id, () =>
          tx.categoriaProducto.create({ data: { id: c.id, nombre: c.nombre } }),
        ),
      ),
    );

    await Promise.all(
      UNIDADES.map((u) =>
        seed(tx, "unidad", u.id, () =>
          tx.unidad.create({
            data: {
              id: u.id,
              tipo: u.tipo,
              nombre: u.nombre,
              abreviatura: u.abreviatura,
            },
          }),
        ),
      ),
    );

    const idRolPorNombre = new Map(ROLES.map((r) => [r.nombre, r.id]));

    await Promise.all(
      ROLES.map((r) =>
        seed(tx, "roles", r.id, () => tx.rol.create({ data: { id: r.id, nombre: r.nombre } })),
      ),
    );

    const hashDev = await Bun.password.hash(DEV_PASSWORD, { algorithm: "argon2id" });

    // Admin (login works), a disabled user (F-01 proof: login must reject estado=false),
    // and an active non-admin (role-check proof: push is Admin-only).
    await Promise.all([
      seed(tx, "persona", ADMIN_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: ADMIN_PERSONA_ID, nombre: "Admin", apellidoPaterno: "Rassa" },
        }),
      ),
      seed(tx, "persona", BLOQUEADO_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: BLOQUEADO_PERSONA_ID, nombre: "Bloqueado", apellidoPaterno: "Rassa" },
        }),
      ),
      seed(tx, "persona", AGRICULTOR_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: AGRICULTOR_PERSONA_ID, nombre: "Agricultor", apellidoPaterno: "Rassa" },
        }),
      ),
      seed(tx, "persona", AGRICULTOR2_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: AGRICULTOR2_PERSONA_ID, nombre: "Agricultor Dos", apellidoPaterno: "Rassa" },
        }),
      ),
      seed(tx, "persona", VENDEDOR_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: VENDEDOR_PERSONA_ID, nombre: "Vendedor", apellidoPaterno: "Rassa" },
        }),
      ),
      seed(tx, "persona", CLIENTE_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: CLIENTE_PERSONA_ID, nombre: "Cliente", apellidoPaterno: "Rassa" },
        }),
      ),
    ]);

    await Promise.all([
      seed(tx, "usuario", ADMIN_ID, () =>
        tx.usuario.create({
          data: {
            id: ADMIN_ID,
            correo: "admin@rassa.local",
            passwordHash: hashDev,
            fkPersona: ADMIN_PERSONA_ID,
            fkRol: idRolPorNombre.get("Admin")!,
          },
        }),
      ),
      seed(tx, "usuario", BLOQUEADO_ID, () =>
        tx.usuario.create({
          data: {
            id: BLOQUEADO_ID,
            correo: "bloqueado@rassa.local",
            passwordHash: hashDev,
            fkPersona: BLOQUEADO_PERSONA_ID,
            fkRol: idRolPorNombre.get("Cliente")!,
            estado: false,
          },
        }),
      ),
      seed(tx, "usuario", AGRICULTOR_ID, () =>
        tx.usuario.create({
          data: {
            id: AGRICULTOR_ID,
            correo: "agricultor@rassa.local",
            passwordHash: hashDev,
            fkPersona: AGRICULTOR_PERSONA_ID,
            fkRol: idRolPorNombre.get("Agricultor")!,
          },
        }),
      ),
      seed(tx, "usuario", AGRICULTOR2_ID, () =>
        tx.usuario.create({
          data: {
            id: AGRICULTOR2_ID,
            correo: "agricultor2@rassa.local",
            passwordHash: hashDev,
            fkPersona: AGRICULTOR2_PERSONA_ID,
            fkRol: idRolPorNombre.get("Agricultor")!,
          },
        }),
      ),
      seed(tx, "usuario", VENDEDOR_ID, () =>
        tx.usuario.create({
          data: {
            id: VENDEDOR_ID,
            correo: "vendedor@rassa.local",
            passwordHash: hashDev,
            fkPersona: VENDEDOR_PERSONA_ID,
            fkRol: idRolPorNombre.get("Vendedor")!,
          },
        }),
      ),
      seed(tx, "usuario", CLIENTE_ID, () =>
        tx.usuario.create({
          data: {
            id: CLIENTE_ID,
            correo: "cliente@rassa.local",
            passwordHash: hashDev,
            fkPersona: CLIENTE_PERSONA_ID,
            fkRol: idRolPorNombre.get("Cliente")!,
          },
        }),
      ),
    ]);

    // ---- Familias module (P0) ----
    // Sample family: jefe = agricultor, member = vendedor, family credit limit and its
    // group conversation (idempotent by fixed ids + guarded inserts).
    await seed(tx, "familia", FAMILIA_ID, () =>
      tx.familia.create({
        data: { id: FAMILIA_ID, nombre: "Familia Prueba Nayarit", fkJefeUsuario: AGRICULTOR_ID },
      }),
    );
    await Promise.all([
      seed(tx, "familia_usuario", MEMBRESIA_AGRICULTOR_ID, () =>
        tx.familiaUsuario.create({
          data: { id: MEMBRESIA_AGRICULTOR_ID, fkFamilia: FAMILIA_ID, fkUsuario: AGRICULTOR_ID },
        }),
      ),
      seed(tx, "familia_usuario", MEMBRESIA_VENDEDOR_ID, () =>
        tx.familiaUsuario.create({
          data: { id: MEMBRESIA_VENDEDOR_ID, fkFamilia: FAMILIA_ID, fkUsuario: VENDEDOR_ID },
        }),
      ),
    ]);
    await seed(tx, "limite_credito", LIMITE_FAMILIA_ID, () =>
      tx.limiteCredito.create({
        data: { id: LIMITE_FAMILIA_ID, monto: 5000, fkFamilia: FAMILIA_ID },
      }),
    );
    await seed(tx, "conversacion", FAMILIA_CONVERSACION_ID, () =>
      tx.conversacion.create({
        data: {
          id: FAMILIA_CONVERSACION_ID,
          fkFamilia: FAMILIA_ID,
          tipo: true,
          integrantes: {
            create: [
              { fkUsuario: AGRICULTOR_ID, rol: "admin" },
              { fkUsuario: VENDEDOR_ID, rol: "miembro" },
            ],
          },
        },
      }),
    );
    // Standalone client with an individual credit limit (M-8 owner XOR: usuario side).
    await seed(tx, "limite_credito", LIMITE_CLIENTE_ID, () =>
      tx.limiteCredito.create({
        data: { id: LIMITE_CLIENTE_ID, monto: 1000, fkUsuario: CLIENTE_ID },
      }),
    );
    // ---- Productos module (P0): master catalog samples (Q-19: Admin-owned) ----
    await Promise.all(
      PRODUCTOS.map((p) => {
        const fkCategoria = CATEGORIAS.find((c) => c.nombre === p.categoria)?.id;
        if (!fkCategoria) throw new Error(`Categoria desconocida en seed: ${p.categoria}`);
        const fkUnidad = p.unidad
          ? (UNIDADES.find((u) => u.nombre === p.unidad)?.id ?? null)
          : null;
        return seed(tx, "producto", p.id, () =>
          tx.producto.create({
            data: { id: p.id, nombre: p.nombre, descripcion: p.descripcion, fkCategoria, fkUnidad },
          }),
        );
      }),
    );
    // ---- Publicaciones module (P0): published offer for the CURRENT ciclo ----
    await seed(tx, "publicacion_semanal", PUBLICACION_ID, () =>
      tx.publicacionSemanal.create({
        data: {
          id: PUBLICACION_ID,
          fkAgricultor: AGRICULTOR_ID,
          fechaCiclo: lunesCiclo,
          semanaIso,
          anioIso,
          estado: ESTADO_PUBLICACION.PUBLICADO,
        },
      }),
    );
    await Promise.all(
      ITEMS_SEMANALES.map((i) => {
        const producto = PRODUCTOS.find((p) => p.nombre === i.producto);
        const fkUnidad = producto?.unidad
          ? UNIDADES.find((u) => u.nombre === producto.unidad)?.id
          : undefined;
        if (!producto || !fkUnidad)
          throw new Error(`Producto/unidad desconocido en seed: ${i.producto}`);
        return seed(tx, "producto_semanal", i.id, () =>
          tx.productoSemanal.create({
            data: {
              id: i.id,
              fkPublicacion: PUBLICACION_ID,
              fkProducto: producto.id,
              fkUnidad,
              precio: i.precio,
              stock: i.stock,
              estado: ESTADO_ITEM_SEMANAL.ACTIVO,
            },
          }),
        );
      }),
    );
  });

  console.log(
    `Dev seed applied: 7 estados de pedido, 5 municipios, 10 localidades, 4 categorías, 3 unidades, 4 roles, admin + agricultor + agricultor2 + vendedor + cliente + bloqueado, familia con límite y conversación, 6 productos, publicación publicada para el ciclo ${aFechaCiclo(lunesCiclo)} (semana ISO ${semanaIso}) con 3 artículos`,
  );
  await db.$disconnect();
}

main().catch((error) => {
  console.error("Dev seed failed:", error);
  process.exit(1);
});
