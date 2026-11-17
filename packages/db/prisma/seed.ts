// DEV SEED — Nayarit sample data for the vertical slice (PULL demo data).
// Idempotent: fixed UUIDs + guarded inserts; every seeded row writes its sync_cambio row in the
// same transaction (M-1a) so the PULL checkpoint sees it. Run with: bun prisma/seed.ts

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/client";
import type { Prisma } from "./generated/client";

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

// Insert the business row and its outbox row together; skip both when already seeded.
async function sembrar(
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
  await db.$transaction(async (tx) => {
    const idsMunicipio = new Map(MUNICIPIOS.map((m) => [m.nombre, m.id]));

    await Promise.all(
      MUNICIPIOS.map((m) =>
        sembrar(tx, "municipio", m.id, () =>
          tx.municipio.create({ data: { id: m.id, nombre: m.nombre } }),
        ),
      ),
    );

    await Promise.all(
      LOCALIDADES.map((l) => {
        const fkMunicipio = idsMunicipio.get(l.municipio);
        if (!fkMunicipio) throw new Error(`Municipio desconocido en seed: ${l.municipio}`);
        return sembrar(tx, "localidad", l.id, () =>
          tx.localidad.create({
            data: { id: l.id, fkMunicipio, nombre: l.nombre },
          }),
        );
      }),
    );

    await Promise.all(
      CATEGORIAS.map((c) =>
        sembrar(tx, "categoria_producto", c.id, () =>
          tx.categoriaProducto.create({ data: { id: c.id, nombre: c.nombre } }),
        ),
      ),
    );

    await Promise.all(
      UNIDADES.map((u) =>
        sembrar(tx, "unidad", u.id, () =>
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
        sembrar(tx, "roles", r.id, () => tx.rol.create({ data: { id: r.id, nombre: r.nombre } })),
      ),
    );

    const hashDev = await Bun.password.hash(DEV_PASSWORD, { algorithm: "argon2id" });

    // Admin (login works), a disabled user (F-01 proof: login must reject estado=false),
    // and an active non-admin (role-check proof: push is Admin-only).
    await Promise.all([
      sembrar(tx, "persona", ADMIN_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: ADMIN_PERSONA_ID, nombre: "Admin", apellidoPaterno: "Rassa" },
        }),
      ),
      sembrar(tx, "persona", BLOQUEADO_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: BLOQUEADO_PERSONA_ID, nombre: "Bloqueado", apellidoPaterno: "Rassa" },
        }),
      ),
      sembrar(tx, "persona", AGRICULTOR_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: AGRICULTOR_PERSONA_ID, nombre: "Agricultor", apellidoPaterno: "Rassa" },
        }),
      ),
      sembrar(tx, "persona", VENDEDOR_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: VENDEDOR_PERSONA_ID, nombre: "Vendedor", apellidoPaterno: "Rassa" },
        }),
      ),
      sembrar(tx, "persona", CLIENTE_PERSONA_ID, () =>
        tx.persona.create({
          data: { id: CLIENTE_PERSONA_ID, nombre: "Cliente", apellidoPaterno: "Rassa" },
        }),
      ),
    ]);

    await Promise.all([
      sembrar(tx, "usuario", ADMIN_ID, () =>
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
      sembrar(tx, "usuario", BLOQUEADO_ID, () =>
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
      sembrar(tx, "usuario", AGRICULTOR_ID, () =>
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
      sembrar(tx, "usuario", VENDEDOR_ID, () =>
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
      sembrar(tx, "usuario", CLIENTE_ID, () =>
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
    await sembrar(tx, "familia", FAMILIA_ID, () =>
      tx.familia.create({
        data: { id: FAMILIA_ID, nombre: "Familia Prueba Nayarit", fkJefeUsuario: AGRICULTOR_ID },
      }),
    );
    await Promise.all([
      sembrar(tx, "familia_usuario", MEMBRESIA_AGRICULTOR_ID, () =>
        tx.familiaUsuario.create({
          data: { id: MEMBRESIA_AGRICULTOR_ID, fkFamilia: FAMILIA_ID, fkUsuario: AGRICULTOR_ID },
        }),
      ),
      sembrar(tx, "familia_usuario", MEMBRESIA_VENDEDOR_ID, () =>
        tx.familiaUsuario.create({
          data: { id: MEMBRESIA_VENDEDOR_ID, fkFamilia: FAMILIA_ID, fkUsuario: VENDEDOR_ID },
        }),
      ),
    ]);
    await sembrar(tx, "limite_credito", LIMITE_FAMILIA_ID, () =>
      tx.limiteCredito.create({
        data: { id: LIMITE_FAMILIA_ID, monto: 5000, fkFamilia: FAMILIA_ID },
      }),
    );
    await sembrar(tx, "conversacion", FAMILIA_CONVERSACION_ID, () =>
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
    await sembrar(tx, "limite_credito", LIMITE_CLIENTE_ID, () =>
      tx.limiteCredito.create({
        data: { id: LIMITE_CLIENTE_ID, monto: 1000, fkUsuario: CLIENTE_ID },
      }),
    );
  });

  console.log(
    "Dev seed applied: 5 municipios, 10 localidades, 4 categorías, 3 unidades, 4 roles, admin + agricultor + vendedor + cliente + bloqueado, familia con límite y conversación",
  );
  await db.$disconnect();
}

main().catch((error) => {
  console.error("Dev seed failed:", error);
  process.exit(1);
});
