import { useRxQueryBase, type UseRxQueryOptions, type UseRxQueryResult } from "rxdb/plugins/react";

/**
 * Live variant of rxdb's `useRxQuery`: the plugin's convenience export hardcodes
 * `live: false` (rxdb 17.6 — its own type even rejects the key), so lists ran
 * ONCE per mount and every RxDB-backed screen went stale until a reload. QA
 * F17-r3 root cause; this wrapper re-subscribes to `query.$` so optimistic
 * patches and PULLs render immediately.
 */
export function useRxQueryLive<
  RxDocumentType,
  OrmMethods = {},
  StaticMethods = {},
  InstanceCreationOptions = {},
  Reactivity = unknown,
>(
  options: Omit<
    UseRxQueryOptions<
      RxDocumentType,
      OrmMethods,
      StaticMethods,
      InstanceCreationOptions,
      Reactivity
    >,
    "live"
  >,
): UseRxQueryResult<RxDocumentType, OrmMethods> {
  return useRxQueryBase({ ...options, live: true }) as UseRxQueryResult<RxDocumentType, OrmMethods>;
}
