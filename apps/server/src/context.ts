import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

import type { Context as ApiContext } from "@rassa-jala/api/context";
import { ROLE } from "@rassa-jala/api/context";

import { db } from "./services";

// slice-decision: auth module replaces this (P0) — fixed dev-stub identity for the vertical slice.
const DEV_STUB_USER = { id: "slice-dev-admin", role: ROLE.ADMIN } as const;

export function createContext(_opts: FetchCreateContextFnOptions): ApiContext {
  return {
    db,
    user: DEV_STUB_USER,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
