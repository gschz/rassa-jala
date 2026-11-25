// Gap 24 corrective: write-through invalidation for the dashboard TTL cache.
// A plain TTL (30s) served stale aggregates after a write (e.g. a seller registers
// an in-person order + payment and the dashboard still reported the old total for
// up to 30s). Fix: a generation counter — every successful mutation bumps it and
// the cache key embeds it, so any pre-write entry becomes unreachable immediately.
//
// Leaf module on purpose (zero imports): both `dashboard.ts` (reads) and the
// `protectedProcedure` middleware in `src/index.ts` (invalidation on mutations)
// use it without creating import cycles. Over-invalidation is accepted by design:
// a bump only forces a recompute of the next dashboard read (bounded per-user
// keys), it never blocks a write.

const DASHBOARD_CACHE_TTL_MS = 30_000;
const dashboardCache = new Map<string, { at: number; data: unknown }>();

let generacion = 0;

/** Bump the cache generation: every cached dashboard entry becomes unreachable. */
export function invalidarDashboard(): void {
  generacion += 1;
}

export async function cachedDashboard<T>(
  rol: string,
  fkUsuario: string,
  compute: () => Promise<T>,
): Promise<T> {
  // No input filters exist on these procedures — the caller's identity IS the
  // cache-key signature (generation + role + user).
  const key = `${generacion}:${rol}:${fkUsuario}`;
  const hit = dashboardCache.get(key);
  if (hit && Date.now() - hit.at < DASHBOARD_CACHE_TTL_MS) {
    return hit.data as T;
  }
  const data = await compute();
  // Crude size guard: keys are bounded by dashboard viewers, but a long-lived
  // process with many users must not grow the map forever (superseded
  // generations are dropped wholesale once the map fills).
  if (dashboardCache.size >= 500) dashboardCache.clear();
  dashboardCache.set(key, { at: Date.now(), data });
  return data;
}
