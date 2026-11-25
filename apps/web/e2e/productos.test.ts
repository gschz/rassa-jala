import "./helpers";

import { existsSync } from "node:fs";

import { beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN,
  AGRO,
  BASE_URL,
  DEV_PASSWORD,
  STORAGE_TEST_DIR,
  ensureServer,
  login,
  maxSeq,
  must,
  JPEG_BASE64,
  pgQuery,
  pgUna,
  PNG_BASE64,
  PNG_BYTES,
  pullHasta,
  sufijo,
  tokenDe,
  trpc,
} from "./helpers";

const T = 240_000;

type ProductoDto = {
  id: string;
  nombre: string;
  descripcion: string | null;
  estado: boolean;
  version: number;
  fkUnidad: string | null;
  imagenes: ImagenDto[];
};
type ImagenDto = {
  id: string;
  storageKey: string;
  url: string;
  orden: number;
  principal: boolean;
  estado: boolean;
  version: number;
};
type ProductoPullDoc = {
  id: string;
  nombre: string;
  estado: boolean;
  version: number;
  _deleted: boolean;
};
type ImagenPullDoc = {
  id: string;
  storageKey: string;
  url: string;
  principal: boolean;
  _deleted: boolean;
};

// Uploads are content-validated server-side (magic-byte signature must match the
// declared MIME), so fixtures carry real PNG/JPEG signatures.

describe("productos e2e (p0-productos proofs)", () => {
  let adminToken = "";
  let adminId = "";
  let agroToken = "";
  let categoriaId = "";
  let unidadId = "";

  beforeAll(async () => {
    await ensureServer();
    const ses = await login(ADMIN, DEV_PASSWORD);
    adminToken = ses.token;
    adminId = ses.user.id;
    agroToken = await tokenDe(AGRO, DEV_PASSWORD);
    categoriaId = (
      await pgUna<{ id: string }>(
        "select id from categoria_producto where estado order by id limit 1",
      )
    ).id;
    unidadId = (
      await pgUna<{ id: string }>("select id from unidad where estado order by id limit 1")
    ).id;
  }, 90_000);

  test(
    "create writes v1 + the outbox row in the same tx and PULL delivers it",
    async () => {
      const nombre = `QA Prod e2e ${sufijo()}`;
      const cp = await maxSeq("producto");
      const creado = await must<ProductoDto>(
        "mutation",
        "productos.create",
        { nombre, descripcion: "producto e2e", fkCategoria: categoriaId, fkUnidad: unidadId },
        adminToken,
      );
      expect(creado.nombre).toBe(nombre);
      expect(creado.estado).toBe(true);
      expect(creado.version).toBe(1);
      expect(creado.imagenes).toHaveLength(0);

      const outbox = await pgQuery<{ operacion: string; actor: string }>(
        "select operacion, actor from sync_cambio where tabla_origen = 'producto' and id_fila = $1",
        [creado.id],
      );
      expect(outbox.length).toBe(1);
      expect(outbox[0]?.operacion).toBe("insert");
      expect(outbox[0]?.actor).toBe(adminId);

      const docs = await pullHasta<ProductoPullDoc>("productos", cp, adminToken, (ds) =>
        ds.some((d) => d.id === creado.id),
      );
      const doc = docs.find((d) => d.id === creado.id);
      expect(doc?.nombre).toBe(nombre);
      expect(doc?.version).toBe(1);
      expect(doc?._deleted).toBe(false);
    },
    T,
  );

  test(
    "duplicate name -> 409 with the exact catalog message",
    async () => {
      const nombre = `QA Prod Dup e2e ${sufijo()}`;
      await must<ProductoDto>(
        "mutation",
        "productos.create",
        { nombre, fkCategoria: categoriaId },
        adminToken,
      );
      const dup = await trpc(
        "mutation",
        "productos.create",
        { nombre, fkCategoria: categoriaId },
        adminToken,
      );
      expect(dup.ok).toBe(false);
      if (dup.ok) return;
      expect(dup.status).toBe(409);
      expect(dup.errorMessage).toBe(`Ya existe un producto con el nombre "${nombre}"`);
    },
    T,
  );

  test(
    "update CAS: replaying the old version -> 409 with the server version",
    async () => {
      const nombre = `QA Prod CAS e2e ${sufijo()}`;
      const creado = await must<ProductoDto>(
        "mutation",
        "productos.create",
        { nombre, fkCategoria: categoriaId, fkUnidad: unidadId },
        adminToken,
      );
      const upd = await must<ProductoDto>(
        "mutation",
        "productos.update",
        { id: creado.id, version: 1, nombre: `${nombre} v2`, fkUnidad: null },
        adminToken,
      );
      expect(upd.version).toBe(2);
      expect(upd.fkUnidad).toBeNull();

      const replay = await trpc(
        "mutation",
        "productos.update",
        { id: creado.id, version: 1, nombre: `${nombre} v3` },
        adminToken,
      );
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.status).toBe(409);
        expect(replay.errorMessage).toContain("Conflicto de versión");
        expect(replay.errorMessage).toContain("versión actual: 2");
        expect(replay.errorMessage).toContain("enviada: 1");
      }
    },
    T,
  );

  test(
    "setEstado soft-delete bumps the version and PULL delivers the tombstone",
    async () => {
      const nombre = `QA Prod Baja e2e ${sufijo()}`;
      const cp = await maxSeq("producto");
      const creado = await must<ProductoDto>(
        "mutation",
        "productos.create",
        { nombre, fkCategoria: categoriaId },
        adminToken,
      );
      await must<{ ok: true }>(
        "mutation",
        "productos.setEstado",
        { id: creado.id, version: 1, estado: false },
        adminToken,
      );
      const fila = await pgUna<{ estado: boolean; version: number }>(
        "select estado, version::int from producto where id = $1",
        [creado.id],
      );
      expect(fila.estado).toBe(false);
      expect(fila.version).toBe(2);

      const docs = await pullHasta<ProductoPullDoc>("productos", cp, adminToken, (ds) =>
        ds.some((d) => d.id === creado.id),
      );
      expect(docs.find((d) => d.id === creado.id)?._deleted).toBe(true);
    },
    T,
  );

  test(
    "image lifecycle: disk file + HTTP serve, principal/orden flags, setPrincipal, delete unlink",
    async () => {
      const nombre = `QA Prod Img e2e ${sufijo()}`;
      const producto = await must<ProductoDto>(
        "mutation",
        "productos.create",
        { nombre, fkCategoria: categoriaId, fkUnidad: unidadId },
        adminToken,
      );
      const cp = await maxSeq("producto_imagen");

      const primera = await must<ImagenDto>(
        "mutation",
        "productos.imagenes.upload",
        {
          fkProducto: producto.id,
          fileName: "foto.png",
          mimeType: "image/png",
          dataBase64: PNG_BASE64,
        },
        adminToken,
      );
      expect(primera.principal).toBe(true);
      expect(primera.orden).toBe(0);
      expect(primera.storageKey).toMatch(/^productos\/[0-9a-f-]{36}\.png$/);
      expect(existsSync(`${STORAGE_TEST_DIR}/${primera.storageKey}`)).toBe(true);

      const servida = await fetch(`${BASE_URL}${primera.url}`);
      expect(servida.status).toBe(200);
      expect(servida.headers.get("content-type")).toBe("image/png");
      expect((await servida.arrayBuffer()).byteLength).toBe(PNG_BYTES.byteLength);

      const segunda = await must<ImagenDto>(
        "mutation",
        "productos.imagenes.upload",
        {
          fkProducto: producto.id,
          fileName: "foto2.jpeg",
          mimeType: "image/jpeg",
          dataBase64: JPEG_BASE64,
        },
        adminToken,
      );
      expect(segunda.principal).toBe(false);
      expect(segunda.orden).toBe(1);

      // PULL: refs only (no binary payload) under a fresh outbox row.
      const docs = await pullHasta<ImagenPullDoc>(
        "imagenes",
        cp,
        adminToken,
        (ds) => ds.some((d) => d.id === primera.id) && ds.some((d) => d.id === segunda.id),
      );
      const doc = docs.find((d) => d.id === primera.id);
      expect(doc?.url).toBe(primera.url);
      expect(doc?.storageKey).toBe(primera.storageKey);
      expect(Object.keys(doc ?? {})).not.toContain("data");

      // Promote the second image: the first is unset, both versions bump.
      const promovida = await must<ImagenDto>(
        "mutation",
        "productos.imagenes.setPrincipal",
        { id: segunda.id, version: 1 },
        adminToken,
      );
      expect(promovida.principal).toBe(true);
      const filas = await pgQuery<{ id: string; principal: boolean; version: number }>(
        "select id, principal, version::int from producto_imagen where fk_producto = $1 order by orden",
        [producto.id],
      );
      expect(filas.find((f) => f.id === primera.id)?.principal).toBe(false);
      expect(filas.find((f) => f.id === segunda.id)?.principal).toBe(true);

      // Delete the physical row + best-effort unlink (outbox 'delete' tombstone).
      const versionPrimera = filas.find((f) => f.id === primera.id)?.version ?? 1;
      await must<{ ok: true }>(
        "mutation",
        "productos.imagenes.delete",
        { id: primera.id, version: versionPrimera },
        adminToken,
      );
      expect(
        await pgUna<{ n: number }>("select count(*)::int n from producto_imagen where id = $1", [
          primera.id,
        ]),
      ).toEqual({ n: 0 });
      expect((await fetch(`${BASE_URL}${primera.url}`)).status).toBe(404);
      const outbox = await pgQuery<{ operacion: string }>(
        "select operacion from sync_cambio where tabla_origen = 'producto_imagen' and id_fila = $1",
        [primera.id],
      );
      expect(outbox.some((o) => o.operacion === "delete")).toBe(true);
    },
    T,
  );

  test(
    "deleting the principal auto-promotes the next by orden (same-tx outbox update); last delete leaves none",
    async () => {
      const producto = await must<ProductoDto>(
        "mutation",
        "productos.create",
        { nombre: `QA Prod Prom e2e ${sufijo()}`, fkCategoria: categoriaId },
        adminToken,
      );
      const subir = (fileName: string): Promise<ImagenDto> =>
        must<ImagenDto>(
          "mutation",
          "productos.imagenes.upload",
          {
            fkProducto: producto.id,
            fileName,
            mimeType: "image/png",
            dataBase64: PNG_BASE64,
          },
          adminToken,
        );
      const a = await subir("a.png"); // principal, orden 0
      const b = await subir("b.png"); // orden 1
      const c = await subir("c.png"); // orden 2
      // Checkpoint AFTER the uploads: the only b doc in PULL range is the promotion.
      const cp = await maxSeq("producto_imagen");

      // Delete the principal → b (next by orden) is promoted in the same tx.
      await must<{ ok: true }>(
        "mutation",
        "productos.imagenes.delete",
        { id: a.id, version: a.version },
        adminToken,
      );
      const filas1 = await pgQuery<{ id: string; principal: boolean; version: number }>(
        "select id, principal, version::int from producto_imagen where fk_producto = $1 order by orden",
        [producto.id],
      );
      expect(filas1).toHaveLength(2);
      expect(filas1.find((f) => f.id === b.id)?.principal).toBe(true);
      expect(filas1.find((f) => f.id === b.id)?.version).toBe(2);
      expect(filas1.find((f) => f.id === c.id)?.principal).toBe(false);
      // The promotion rode its own outbox row → PULL delivers the new principal.
      const docs = await pullHasta<ImagenPullDoc>("imagenes", cp, adminToken, (ds) =>
        ds.some((d) => d.id === b.id),
      );
      expect(docs.find((d) => d.id === b.id)?.principal).toBe(true);

      // Delete the promoted principal → the remaining one is promoted.
      const versionB = filas1.find((f) => f.id === b.id)?.version ?? 1;
      await must<{ ok: true }>(
        "mutation",
        "productos.imagenes.delete",
        { id: b.id, version: versionB },
        adminToken,
      );
      const filas2 = await pgQuery<{ id: string; principal: boolean; version: number }>(
        "select id, principal, version::int from producto_imagen where fk_producto = $1 order by orden",
        [producto.id],
      );
      expect(filas2).toHaveLength(1);
      expect(filas2[0]?.id).toBe(c.id);
      expect(filas2[0]?.principal).toBe(true);

      // Delete the only remaining image → no principal at all (valid state).
      await must<{ ok: true }>(
        "mutation",
        "productos.imagenes.delete",
        { id: c.id, version: filas2[0]?.version ?? 1 },
        adminToken,
      );
      expect(
        await pgUna<{ n: number }>(
          "select count(*)::int n from producto_imagen where fk_producto = $1",
          [producto.id],
        ),
      ).toEqual({ n: 0 });
    },
    T,
  );

  test(
    "upload validation: extension/mime mismatch, invalid base64 and >5 MiB are 400",
    async () => {
      const producto = await must<ProductoDto>(
        "mutation",
        "productos.create",
        { nombre: `QA Prod Val e2e ${sufijo()}`, fkCategoria: categoriaId, fkUnidad: unidadId },
        adminToken,
      );
      // Valid JPEG content but a .png name: signature passes, extension is what fails.
      const mismatch = await trpc(
        "mutation",
        "productos.imagenes.upload",
        {
          fkProducto: producto.id,
          fileName: "foto.png",
          mimeType: "image/jpeg",
          dataBase64: JPEG_BASE64,
        },
        adminToken,
      );
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) {
        expect(mismatch.status).toBe(400);
        expect(mismatch.errorMessage).toBe(
          "La extensión del archivo no coincide con su tipo de contenido",
        );
      }

      // Lying MIME: PNG bytes declared as JPEG (with a matching name) → content wins.
      const mentiroso = await trpc(
        "mutation",
        "productos.imagenes.upload",
        {
          fkProducto: producto.id,
          fileName: "foto.jpg",
          mimeType: "image/jpeg",
          dataBase64: PNG_BASE64,
        },
        adminToken,
      );
      expect(mentiroso.ok).toBe(false);
      if (!mentiroso.ok) {
        expect(mentiroso.status).toBe(400);
        expect(mentiroso.errorMessage).toBe(
          "El contenido del archivo no coincide con el tipo de imagen declarado",
        );
      }

      // Unknown signature (plain text, no PNG/JPEG/WebP magic) is rejected too.
      const firmaDesconocida = await trpc(
        "mutation",
        "productos.imagenes.upload",
        {
          fkProducto: producto.id,
          fileName: "foto.png",
          mimeType: "image/png",
          dataBase64: Buffer.from("texto-sin-firma").toString("base64"),
        },
        adminToken,
      );
      expect(firmaDesconocida.ok).toBe(false);
      if (!firmaDesconocida.ok) {
        expect(firmaDesconocida.status).toBe(400);
        expect(firmaDesconocida.errorMessage).toBe(
          "El contenido del archivo no coincide con el tipo de imagen declarado",
        );
      }

      const invalido = await trpc(
        "mutation",
        "productos.imagenes.upload",
        {
          fkProducto: producto.id,
          fileName: "foto.png",
          mimeType: "image/png",
          dataBase64: "no-es-base64!!",
        },
        adminToken,
      );
      expect(invalido.ok).toBe(false);
      if (!invalido.ok) expect(invalido.errorMessage).toBe("El archivo no es base64 válido");

      const grande = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString("base64");
      const oversize = await trpc(
        "mutation",
        "productos.imagenes.upload",
        {
          fkProducto: producto.id,
          fileName: "grande.png",
          mimeType: "image/png",
          dataBase64: grande,
        },
        adminToken,
      );
      expect(oversize.ok).toBe(false);
      if (!oversize.ok) {
        expect(oversize.status).toBe(400);
        expect(oversize.errorMessage).toBe("La imagen supera el tamaño máximo de 5 MiB");
      }

      // No row leaked for the rejected uploads.
      expect(
        await pgUna<{ n: number }>(
          "select count(*)::int n from producto_imagen where fk_producto = $1",
          [producto.id],
        ),
      ).toEqual({ n: 0 });
    },
    T,
  );

  test(
    "multipart upload (gap 3): binary PNG stored+served, lying signature/oversize/role 400-403, one destination",
    async () => {
      const producto = await must<ProductoDto>(
        "mutation",
        "productos.create",
        {
          nombre: `QA Prod Multipart e2e ${sufijo()}`,
          fkCategoria: categoriaId,
          fkUnidad: unidadId,
        },
        adminToken,
      );
      const cp = await maxSeq("producto_imagen");

      const subir = (armar: (form: FormData) => void, token = adminToken): Promise<Response> => {
        const form = new FormData();
        armar(form);
        return fetch(`${BASE_URL}/upload/imagenes`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: form,
        });
      };

      // Happy path: the real PNG signature rides the wire as multipart binary (the
      // wire no longer carries base64); the stored/served bytes are the same pipeline.
      const ok = await subir((form) => {
        form.append("fkProducto", producto.id);
        form.append("file", new File([PNG_BYTES], "foto.png", { type: "image/png" }));
      });
      expect(ok.status).toBe(200);
      // createCaller returns the procedure output verbatim (the tRPC envelope is
      // transport-only): the ImagenDto directly.
      const subida = (await ok.json()) as ImagenDto;
      expect(subida.principal).toBe(true);
      expect(existsSync(`${STORAGE_TEST_DIR}/${subida.storageKey}`)).toBe(true);
      const servida = await fetch(`${BASE_URL}${subida.url}`);
      expect(servida.status).toBe(200);
      expect((await servida.arrayBuffer()).byteLength).toBe(PNG_BYTES.byteLength);

      // Lying signature: text bytes declared image/png → 400 with the shared message.
      const mentiroso = await subir((form) => {
        form.append("fkProducto", producto.id);
        form.append(
          "file",
          new File([Buffer.from("texto-sin-firma")], "foto.png", { type: "image/png" }),
        );
      });
      expect(mentiroso.status).toBe(400);
      expect(((await mentiroso.json()) as { error: string }).error).toBe(
        "El contenido del archivo no coincide con el tipo de imagen declarado",
      );

      // Oversize (>5 MiB) → 400.
      const grande = await subir((form) => {
        form.append("fkProducto", producto.id);
        form.append(
          "file",
          new File([Buffer.alloc(5 * 1024 * 1024 + 1, 1)], "grande.png", { type: "image/png" }),
        );
      });
      expect(grande.status).toBe(400);
      expect(((await grande.json()) as { error: string }).error).toBe(
        "La imagen supera el tamaño máximo de 5 MiB",
      );

      // Exactly one destination (both set → 400).
      const doble = await subir((form) => {
        form.append("fkProducto", producto.id);
        form.append("fkProductoSemanal", crypto.randomUUID());
        form.append("file", new File([PNG_BYTES], "foto.png", { type: "image/png" }));
      });
      expect(doble.status).toBe(400);

      // Same role gates as the tRPC transport (protectedProcedure via createCaller).
      const agro = await subir((form) => {
        form.append("fkProducto", producto.id);
        form.append("file", new File([PNG_BYTES], "foto.png", { type: "image/png" }));
      }, agroToken);
      expect(agro.status).toBe(403);
      expect(((await agro.json()) as { error: string }).error).toBe(
        "Solo el rol Admin puede modificar los productos",
      );

      // Only the happy-path row landed, and it rides the outbox for PULL (refs only).
      expect(
        await pgUna<{ n: number }>(
          "select count(*)::int n from producto_imagen where fk_producto = $1",
          [producto.id],
        ),
      ).toEqual({ n: 1 });
      const docs = await pullHasta<ImagenPullDoc>("imagenes", cp, adminToken, (ds) =>
        ds.some((d) => d.id === subida.id),
      );
      expect(docs.find((d) => d.id === subida.id)?.url).toBe(subida.url);
    },
    T,
  );

  test(
    "Agricultor mutations -> 403 'Solo el rol Admin puede modificar los productos'",
    async () => {
      const producto = await must<ProductoDto>(
        "mutation",
        "productos.create",
        { nombre: `QA Prod Rol e2e ${sufijo()}`, fkCategoria: categoriaId },
        adminToken,
      );
      const llamadas = [
        ["productos.create", { nombre: `QA Prod Agro e2e ${sufijo()}`, fkCategoria: categoriaId }],
        ["productos.update", { id: producto.id, version: 1, nombre: `${producto.nombre} x` }],
        ["productos.setEstado", { id: producto.id, version: 1, estado: false }],
        [
          "productos.imagenes.upload",
          {
            fkProducto: producto.id,
            fileName: "x.png",
            mimeType: "image/png",
            dataBase64: PNG_BASE64,
          },
        ],
      ] as const;
      for (const [path, input] of llamadas) {
        const res = await trpc("mutation", path, input, agroToken);
        expect(res.ok).toBe(false);
        if (res.ok) continue;
        expect(res.status).toBe(403);
        expect(res.errorCode).toBe("FORBIDDEN");
        expect(res.errorMessage).toBe("Solo el rol Admin puede modificar los productos");
      }
    },
    T,
  );
});
