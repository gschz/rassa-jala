import "./helpers";
import "fake-indexeddb/auto";

import { beforeAll, describe, expect, test } from "bun:test";
import { createRxDatabase } from "rxdb/plugins/core";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import {
  collectionCreators,
  type PedidoDoc,
  type RassaCollections,
} from "../src/lib/rxdb/database";
import { aDocPedidoLocal, parchearPedidoLocal } from "../src/lib/rxdb/pedido-local";
import { completarTombstone } from "../src/lib/rxdb/tombstone";
import { pullBatch, type SyncCheckpoint } from "../src/lib/rxdb/sync-client";
import { decideRewind } from "../src/lib/rxdb/rewind";
import { replicateRxCollection } from "rxdb/plugins/replication";

import {
  ADMIN,
  DEV_PASSWORD,
  VENDEDOR,
  ensureFixtures,
  ensureServer,
  madurarOutbox,
  maxSeq,
  PULL_DEADLINE_MS,
  pgQuery,
  pgUna,
  pullUna,
  sleep,
  sufijo,
  tokenDe,
  trpc,
  pushComo,
  usarToken,
} from "./helpers";

const T = 240_000;

// sync-freshness e2e (roadmap gap 2 — QA F17-r2 evidence; sync doc §4.2):
// 1. STARVATION FIX: a collection whose checkpoint sits behind young interleaved
//    outbox rows of OTHER tables still receives its own rows up to the aged head
//    (the previous contiguity walk cut the batch at the first inter-collection
//    gap and returned empty forever).
// 2. AGING WINDOW INTACT: a young row above the aged head stays withheld until
//    it ages past the window (out-of-order COMMIT protection — non-negotiable).
// 3. OPTIMISTIC PATCH: after registrarPago the LOCAL RxDB doc flips to
//    "confirmado" immediately (no PULL), and a later PULL converges to the SAME
//    values (server truth == patched truth — no conflict churn).
//
// RxDB runs headless on fake-indexeddb (rxdb-check.ts pattern; the session lib
// guards localStorage, so nothing browser-only is touched).

// Dexie must be handed the fake implementation explicitly (bun evaluates the
// CJS dexie build before fake-indexeddb's globals are installed).
const FAKE_DEXIE_SETTINGS = {
  indexedDB: fakeIndexedDB,
  IDBKeyRange: fakeIDBKeyRange,
};

type PedidoDto = {
  id: string;
  folio: string;
  fkCliente: string | null;
  fkVendedor: string | null;
  estadoNombre: string;
  estado: boolean;
  subtotal: string;
  iva: string;
  total: string;
  origen: string;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  notas: string | null;
  version: number;
  actualizadoEn: string;
  detalles: Array<{
    id: string;
    fkProductoSemanal: string;
    nombreProducto: string;
    cantidad: number;
    precioUnitario: string;
    importe: string;
  }>;
};

describe("sync-freshness e2e (gap 2 pull starvation + optimistic patch)", () => {
  let vendedorToken = "";
  let adminToken = "";
  const s = sufijo();

  beforeAll(async () => {
    await ensureServer();
    await ensureFixtures();
    vendedorToken = await tokenDe(VENDEDOR, DEV_PASSWORD);
    adminToken = await tokenDe(ADMIN, DEV_PASSWORD);
  }, 90_000);

  /** Per-run in-person order (vendedor-owned, itemMoney ×1). */
  const crearPedido = async (): Promise<PedidoDto> => {
    const { itemMoneyId } = await ensureFixtures();
    const res = await trpc<PedidoDto>(
      "mutation",
      "pedidos.pedidoPresencial",
      {
        clienteNombre: `Fresco${sufijo()}`,
        items: [{ fkProductoSemanal: itemMoneyId, cantidad: 1 }],
      },
      vendedorToken,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("pedidoPresencial falló");
    return res.data;
  };

  const seqDePedido = async (pedidoId: string): Promise<number> => {
    const fila = await pgUna<{ id: number }>(
      "select id::int from sync_cambio where tabla_origen = 'pedido_cabecera' and id_fila = $1 order by id desc limit 1",
      [pedidoId],
    );
    return fila.id;
  };

  test(
    "localidades push role gate is a per-op VERDICT: Vendedor -> 200 + rechazada, no row (gap-pass-6 T3)",
    async () => {
      const docId = crypto.randomUUID();
      const operationId = crypto.randomUUID();
      const resultados = await pushComo(
        "localidades",
        [
          {
            operationId,
            docId,
            op: "create",
            nuevoEstado: {
              fkMunicipio: "00000000-0000-4000-8000-000000000000",
              nombre: `Rol e2e ${sufijo()}`,
              _deleted: false,
            },
            versionAsumida: null,
          },
        ],
        vendedorToken,
      );
      expect(resultados[0]?.veredicto).toBe("rechazada");
      expect(resultados[0]?.motivo).toBe("Solo el rol Admin puede modificar localidades");
      expect((resultados[0]?.estadoServidor as { _deleted?: boolean } | undefined)?._deleted).toBe(
        true,
      );
      const filas = await pgUna<{ n: number }>(
        "select count(*)::int n from localidad where id = $1",
        [docId],
      );
      expect(filas.n).toBe(0);
      const ops = await pgUna<{ n: number }>(
        "select count(*)::int n from sync_operacion where id = $1 and veredicto = 'rechazada'",
        [operationId],
      );
      expect(ops.n).toBe(1);
    },
    T,
  );

  test(
    "(1) starvation fix: pedidos con checkpoint atrasado recibe SUS filas cruzando gaps intercalados JÓVENES de otras tablas (el corte por contigüidad ya no aplica)",
    async () => {
      const cp0 = await maxSeq("pedido_cabecera");
      // ~24 interleaved NON-pedido outbox rows, deliberately YOUNG (no
      // backdating): the old contiguity walk treated the benign gap between
      // cp0 and the next pedido row as an in-flight seq gap and cut there.
      const localidad = await pgUna<{
        id: string;
        nombre: string;
        version: number;
        fkMunicipio: string;
      }>(
        `select id, nombre, version, fk_municipio as "fkMunicipio"
         from localidad where estado and legacy_id is null order by id limit 1`,
      );
      // legacy_id rows are the restored legacy catalog (T2b import selectivo) —
      // the starvation probe mutates a scratch row, never an imported one.
      for (let i = 0; i < 24; i++) {
        const res = await pushComo(
          "localidades",
          [
            {
              operationId: crypto.randomUUID(),
              docId: localidad.id,
              op: "update" as const,
              nuevoEstado: {
                fkMunicipio: localidad.fkMunicipio,
                nombre: localidad.nombre,
                _deleted: false,
              },
              versionAsumida: localidad.version,
            },
          ],
          adminToken,
        );
        expect(res[0]?.veredicto).toBe("aplicada");
        localidad.version += 1; // server CAS bumped it — the next push targets v+1
      }

      // Two pedidos: P1 (young) and P2 (aged via surgical backdate). The old walk
      // broke at P1's young gap and never reached the AGED P2; the aged head of
      // §4.2 proves the whole prefix (P1 included) safe to deliver.
      const p1 = await crearPedido();
      const p2 = await crearPedido();
      const seqP2 = await seqDePedido(p2.id);
      // test: surgical timing knob (only P2's outbox row is backdated; the
      // original value is restored in finally to leave no drift).
      const originalP2 = await pgUna<{ creadoEn: string }>(
        'select creado_en::text as "creadoEn" from sync_cambio where id = $1',
        [seqP2],
      );
      try {
        await pgQuery(
          "update sync_cambio set creado_en = now() - interval '2 minutes' where id = $1",
          [seqP2],
        );

        // NO madurarOutbox here: the interleaved localidad rows and P1 must stay
        // young for the proof. P1 young + P2 aged is exactly the QA layout.
        let entregados = new Set<string>();
        let cp = cp0;
        for (let i = 0; i < 12 && !entregados.has(p1.id); i++) {
          const pagina = await pullUna<PedidoDoc>("pedidos", cp, vendedorToken);
          for (const d of pagina.documentos) entregados.add(d.id);
          cp = pagina.checkpoint ?? cp;
          if (entregados.has(p1.id)) break;
          await sleep(500);
        }
        expect(entregados.has(p1.id)).toBe(true);
        expect(entregados.has(p2.id)).toBe(true);
        // The checkpoint jumped PAST the interleaved gap (P2's seq).
        expect(cp).toBeGreaterThanOrEqual(seqP2);
      } finally {
        await pgQuery("update sync_cambio set creado_en = $1 where id = $2", [
          originalP2.creadoEn,
          seqP2,
        ]);
      }
    },
    T,
  );

  test(
    "(2) ventana de envejecimiento intacta: una fila joven con una seq FALTANTE en vuelo (hueco sintético sobre el aged head) se RETIENE; se entrega solo cuando la seq aparece (commit) o la fila envejece",
    async () => {
      // Synthetic sync_cambio layout (the task's sanctioned unit-style proof, on the
      // real wire): H = current global max id. H+1 stays ABSENT (a hole = an
      // in-flight transaction's row); a pedido row rides at H+2 (young). Nothing
      // above headSeq may hide there: withheld. Explicit ids sit just above the
      // natural head → setval bumps the sequence past them (no bigserial reissue).
      // The rows are NOT deleted: the outbox is append-only, deleting them would
      // leave permanent holes that block the completeness rule on later runs;
      // they converge (tombstones for nonexistent id_fila) like the other
      // per-run fixtures.
      const { mx } = await pgUna<{ mx: number }>(
        "select coalesce(max(id), 0)::int mx from sync_cambio",
      );
      const h = BigInt(mx);
      // The pull checkpoint must precede the synthetics: maxSeq AFTER the insert
      // would start the walk AT the synthetic row (nothing above it to prove).
      const cp = await maxSeq("pedido_cabecera");
      const fake1 = crypto.randomUUID();
      const fake2 = crypto.randomUUID();
      await pgQuery(
        `insert into sync_cambio (id, tabla_origen, id_fila, operacion, actor, creado_en)
         values (${h + 2n}, 'pedido_cabecera', $1, 'insert', 'e2e-fixture', now())`,
        [fake2],
      );
      await pgQuery(`select setval('sync_cambio_id_seq', ${h + 2n})`);

      // Withheld: the hole at H+1 is a missing seq above the aged head —
      // delivery could skip an in-flight commit → the batch cuts and the
      // checkpoint must NOT move. (Bounded poll ≪ 60 s.)
      for (let i = 0; i < 3; i++) {
        const pagina = await pullUna<PedidoDoc>("pedidos", cp, vendedorToken);
        expect(pagina.documentos.some((d) => d.id === fake2)).toBe(false);
        expect(pagina.checkpoint).toBe(cp);
        await sleep(700);
      }

      // Release — the in-flight seq COMMITS (the hole fills): the young gap above
      // the head becomes complete → the walk crosses it and the checkpoint jumps
      // past BOTH rows. (The resolver drops tombstones for nonexistent id_fila, so
      // the wire proof is the checkpoint, not doc presence — §4.4.)
      await pgQuery(
        `insert into sync_cambio (id, tabla_origen, id_fila, operacion, actor, creado_en)
           values (${h + 1n}, 'pedido_cabecera', $1, 'insert', 'e2e-fixture', now())`,
        [fake1],
      );
      let check = cp;
      for (let i = 0; i < 10 && (check ?? 0) < Number(h) + 2; i++) {
        const pagina = await pullUna<PedidoDoc>("pedidos", check, vendedorToken);
        check = pagina.checkpoint ?? check;
        if ((check ?? 0) >= Number(h) + 2) break;
        await sleep(500);
      }
      expect(check ?? 0).toBeGreaterThanOrEqual(Number(h) + 2);
    },
    T,
  );

  test(
    "(3) parche optimista: tras registrarPago el doc LOCAL de RxDB está 'confirmado' al instante (sin PULL), y el PULL posterior converge al mismo estado",
    async () => {
      const { itemMoneyId } = await ensureFixtures();
      // The local doc is the server truth AT CREATION (pediente), as a pulled
      // doc would be — then the payment mutation + patch run against it.
      const pedido = await crearPedido();
      const db = await createRxDatabase<RassaCollections>({
        name: `sync-fresco-${s}-${pedido.id.slice(0, 8)}`,
        storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS),
        multiInstance: false,
      });
      await db.addCollections({ pedidos: { ...collectionCreators.pedidos } });
      await db.pedidos.insert(aDocPedidoLocal(pedido) as unknown as PedidoDoc);
      const cpAntes = await maxSeq("pedido_cabecera");

      const tipos = (
        (await trpc<Array<{ id: string; nombre: string }>>(
          "query",
          "pagos.tiposPago",
          {},
          vendedorToken,
        )) as { ok: true; data: Array<{ id: string; nombre: string }> }
      ).data;
      const idEfectivo = tipos.find((t) => t.nombre.toLowerCase() === "efectivo")!.id;

      const pago = await trpc<{ estado: string; pedido: PedidoDto }>(
        "mutation",
        "pagos.registrarPago",
        { fkPedido: pedido.id, fkTipoPago: idEfectivo },
        vendedorToken,
      );
      expect(pago.ok).toBe(true);
      if (!pago.ok) return;
      expect(pago.data.pedido.estadoNombre).toBe("confirmado");

      // THE patch under test — the mutation response flips the local doc.
      await parchearPedidoLocal(db, pago.data.pedido);
      const doc = await db.pedidos.findOne(pedido.id).exec();
      expect(doc).not.toBeNull();
      const json = doc!.toJSON() as PedidoDoc;
      expect(json.estadoNombre).toBe("confirmado");
      expect(json.version).toBe(pago.data.pedido.version);
      expect(json.folio).toBe(pedido.folio);
      expect(json.detalles?.length).toBe(pedido.detalles.length);
      expect(json.detalles?.[0]?.fkProductoSemanal).toBe(itemMoneyId);

      // Convergence: the PULL (same outbox window) carries the SAME values —
      // no conflict churn, the patched doc IS the server truth.
      await madurarOutbox(cpAntes);
      let paginaOk = false;
      let check = cpAntes;
      for (let i = 0; i < 12 && !paginaOk; i++) {
        const pagina = await pullUna<PedidoDoc>("pedidos", check, vendedorToken);
        const pulled = pagina.documentos.find((d) => d.id === pedido.id);
        if (pulled) {
          expect(pulled.estadoNombre).toBe("confirmado");
          expect(pulled.version).toBe(json.version);
          paginaOk = true;
          break;
        }
        check = pagina.checkpoint ?? check;
        await sleep(500);
      }
      expect(paginaOk).toBe(true);
      await db.close();
    },
    T,
  );

  // Rewind contract (gap-pass-4, §4.2): the PULL response carries the current
  // outbox head and a checkpoint ahead of it signals the rewind (the empty-batch
  // echo alone would stall the client forever). The RxDB-side reset runs in the
  // app's pull.handler (replication.ts) — this harness drives raw pulls, so the
  // contract assertions below are the e2e surface; the handler branch is
  // exercised by the decideRewind unit next to rewind.ts.
  test(
    "rewind contract: PULL response carries headSeq; an ahead checkpoint exposes the rewind",
    async () => {
      const pedido = await crearPedido();
      const head = await pgUna<{ mx: number }>(
        "select coalesce(max(id), 0)::int mx from sync_cambio",
      );
      expect(head.mx).toBeGreaterThan(0);
      expect(head.mx).toBeGreaterThanOrEqual(await seqDePedido(pedido.id));

      // Simulated restore: the client holds a checkpoint ahead of the outbox.
      const adelantado = head.mx + 1_000_000;
      const rewind = await pullUna<PedidoDoc>("pedidos", adelantado, vendedorToken);
      expect(rewind.documentos).toEqual([]); // pre-existing empty-batch echo
      expect(rewind.checkpoint).toBe(adelantado);
      expect(rewind.headSeq).toBe(head.mx); // rewind signal: strictly below the checkpoint

      // Normal pull keeps the invariant checkpoint <= headSeq (never a rewind).
      const normal = await pullUna<PedidoDoc>("pedidos", 0, vendedorToken);
      expect(normal.headSeq).toBe(head.mx);
      expect(normal.checkpoint ?? 0).toBeLessThanOrEqual(normal.headSeq!);
    },
    T,
  );

  // Orphan outbox row (gap-pass-5 C3): a sync_cambio row whose source row is
  // GONE (QA/e2e reality — the owner product died by CASCADE and cleanups never
  // wrote their own delete row). §4.3: the PULL must deliver a tombstone, not
  // error. The server side already complies (proven on the wire below); the
  // CLIENT regression is pinned here: the minimal tombstone once crashed the
  // dev-mode ajv write check (422 → RC_PULL → the "Error de sincronización en:
  // imagenes" badge loop), the pull handler now normalizes it for every
  // collection at once.
  test(
    "(5) fila outbox huérfana: PULL entrega tombstone (§4.3) y el cliente RxDB la ingiere sin RC_PULL",
    async () => {
      // SQL fixture (test 2 pattern): insert ABOVE the head + setval; backdated
      // so the aging window delivers it now. Append-only outbox: the row STAYS
      // and converges to a tombstone like the other per-run fixtures — no
      // restore, no hole left behind.
      const { mx } = await pgUna<{ mx: number }>(
        "select coalesce(max(id), 0)::int mx from sync_cambio",
      );
      const idFilaFantasma = crypto.randomUUID();
      const cp = await maxSeq("producto_imagen");
      await pgQuery(
        `insert into sync_cambio (id, tabla_origen, id_fila, operacion, actor, creado_en)
         values (${mx + 1}, 'producto_imagen', $1, 'insert', 'e2e-fixture', now() - interval '2 minutes')`,
        [idFilaFantasma],
      );
      await pgQuery("select setval('sync_cambio_id_seq', $1)", [mx + 1]);

      // SERVER contract (§4.3 'fila inexistente → documento _deleted'): the
      // tombstone arrives, the checkpoint advances, no error.
      type DocPulled = { id: string; _deleted?: boolean };
      let tumba: DocPulled | undefined;
      let check = cp;
      for (let i = 0; i < 20 && !tumba; i++) {
        const pagina = await pullUna<DocPulled>("imagenes", check, adminToken);
        tumba = pagina.documentos.find((d) => d.id === idFilaFantasma);
        check = pagina.checkpoint ?? check;
        if ((check ?? 0) >= mx + 1) break;
        await sleep(400);
      }
      expect(tumba).toBeDefined();
      expect(tumba!._deleted).toBe(true);
      expect(check ?? 0).toBeGreaterThanOrEqual(mx + 1);

      // CLIENT regression (dev-mode DVM1 + ajv — the real storage stack in dev):
      // (a) pin the bug: the raw minimal tombstone fails the schema...
      const db = await createRxDatabase<RassaCollections>({
        name: `sync-huerfana-${s}`,
        storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS) }),
        multiInstance: false,
      });
      await db.addCollections({ imagenes: { ...collectionCreators.imagenes } });
      const comoFila = (doc: Record<string, unknown>) =>
        ({
          document: {
            ...doc,
            _meta: { lwt: Date.now() },
            _rev: "01-000000000000",
            _attachments: {},
          },
          previous: undefined,
        }) as never;
      const rechazo = await db.imagenes.storageInstance.bulkWrite(
        [comoFila({ id: idFilaFantasma, _deleted: true })],
        "e2e-orphan-tombstone",
      );
      expect(rechazo.error.length).toBeGreaterThan(0);
      expect(rechazo.error[0]?.status).toBe(422);

      // (b) the fix: the pull handler's normalization (the SAME wire doc) passes
      // validation and lands as a deleted doc — the error loop is gone.
      const tumbaValida = completarTombstone(
        { id: idFilaFantasma, _deleted: true },
        collectionCreators.imagenes.schema,
      );
      const aceptada = await db.imagenes.storageInstance.bulkWrite(
        [comoFila(tumbaValida as unknown as Record<string, unknown>)],
        "e2e-orphan-tombstone",
      );
      expect(aceptada.error.length).toBe(0);
      const enBd = await db.imagenes.storageInstance.findDocumentsById([idFilaFantasma], true);
      expect(enBd.length).toBe(1);
      expect(enBd[0]?._deleted).toBe(true);
      await db.close();
    },
    T,
  );

  // T4 (gap-pass-9): the PURGE tombstone regression behind the owner badge
  // ("Error de sincronización en: pedidos"). A pedido_cabecera outbox row whose
  // business row is GONE (cleanup-dev purge over the append-only outbox)
  // resolves to the §4.3 defensive tombstone; delivered through the REAL
  // replication stack, the tombstone once came out of completarTombstone with
  // RxDB-INTERNAL required fields filled as wrong-typed neutrals
  // (`_attachments: ""`): the replication's per-doc META write stores docData
  // VERBATIM, the meta schema rejects the string (422 → RC_PULL) and the lane
  // error-looped on the badge. Test (5) could not see it — its raw bulkWrite
  // fixture overwrites the internal fields; only the replication plugin's meta
  // write exposes the vector. The lane must ingest the tombstone with ZERO
  // error$ emissions.
  test(
    "(6) pedidos tombstone de fila purgada ingresa por la replicación REAL sin RC_PULL",
    async () => {
      // Synthetic purge (test 2/5 pattern): an outbox row above the head for a
      // pedido id that does NOT exist; backdated so the aging window delivers
      // it now. Append-only: the row STAYS and converges to a tombstone.
      const { mx } = await pgUna<{ mx: number }>(
        "select coalesce(max(id), 0)::int mx from sync_cambio",
      );
      const idPedidoFantasma = crypto.randomUUID();
      await pgQuery(
        `insert into sync_cambio (id, tabla_origen, id_fila, operacion, actor, creado_en)
         values (${mx + 1}, 'pedido_cabecera', $1, 'delete', 'e2e-fixture', now() - interval '2 minutes')`,
        [idPedidoFantasma],
      );
      await pgQuery("select setval('sync_cambio_id_seq', $1)", [mx + 1]);

      // Pin the helper contract directly: the completed tombstone must NOT
      // carry RxDB-internal fields (core fills them on the doc write; the meta
      // write stores docData verbatim and rejects wrong-typed fillers).
      const completa = completarTombstone(
        { id: idPedidoFantasma, _deleted: true },
        collectionCreators.pedidos.schema,
      ) as unknown as Record<string, unknown>;
      expect("_attachments" in completa).toBe(false);
      expect("_rev" in completa).toBe(false);
      expect("_meta" in completa).toBe(false);

      // REAL replication (the app's exact pull path: pullBatch → rewind check →
      // completarTombstone → RxDB write → the plugin's meta write).
      usarToken(adminToken);
      const db = await createRxDatabase<RassaCollections>({
        name: `sync-purgados-${s}`,
        storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie(FAKE_DEXIE_SETTINGS) }),
        multiInstance: false,
      });
      await db.addCollections({ pedidos: { ...collectionCreators.pedidos } });
      const pullHandler = async (
        lastPulledCheckpoint: SyncCheckpoint | undefined,
        batchSize: number,
      ) => {
        let res = await pullBatch<PedidoDoc & { _deleted?: boolean }>(
          "pedidos",
          lastPulledCheckpoint ?? null,
          batchSize,
        );
        if (decideRewind(lastPulledCheckpoint?.seq, res.headSeq)) {
          res = await pullBatch("pedidos", null, batchSize);
        }
        return {
          documents: res.documentos.map(({ _deleted, ...doc }) =>
            completarTombstone(
              { ...doc, _deleted: _deleted === true } as PedidoDoc & { _deleted: boolean },
              db.pedidos.schema.jsonSchema,
            ),
          ),
          checkpoint: res.checkpoint ?? undefined,
        };
      };

      let erroresRcPull = 0;
      const replicacion = replicateRxCollection({
        replicationIdentifier: `e2e-t4-pedidos-${s}`,
        collection: db.pedidos,
        deletedField: "_deleted",
        live: true,
        retryTime: 5_000,
        pull: { batchSize: 200, handler: pullHandler },
      });
      replicacion.error$.subscribe(() => {
        erroresRcPull += 1;
      });

      // The purge tombstone lands as a deleted doc. NOTE: the server's resolved
      // batches are legitimately SHORT (outbox rows for the same pedido dedupe
      // into one doc — 200 rows → 190 docs), and RxDB's downstream stops on a
      // non-full batch by definition — exactly why replication.ts drives the
      // lane with the §10 reSync() interval. Mirror that mechanism here.
      const inicio = Date.now();
      let enBd: Array<{ id: string; _deleted?: boolean }> = [];
      while (Date.now() - inicio < PULL_DEADLINE_MS) {
        replicacion.reSync();
        enBd = await db.pedidos.storageInstance.findDocumentsById([idPedidoFantasma], true);
        if (enBd.length > 0) break;
        await sleep(400);
      }
      expect(enBd.length).toBe(1);
      expect(enBd[0]?._deleted).toBe(true);
      // The badge regression: NOT A SINGLE error$ emission for the whole lane.
      expect(erroresRcPull).toBe(0);
      await replicacion.cancel();
      await db.close();
    },
    T,
  );
});
