import { useEffect, useState } from "react";

import { getDatabase, type RassaDatabase } from "./database";

/** Resolves the singleton RxDB database once; null while it is still opening. */
export function useDatabase(): RassaDatabase | null {
  const [db, setDb] = useState<RassaDatabase | null>(null);
  useEffect(() => {
    let active = true;
    void getDatabase().then((db) => {
      if (active) setDb(db);
    });
    return () => {
      active = false;
    };
  }, []);
  return db;
}
