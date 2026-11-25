import "varlock/auto-load";

import { describe, expect, test } from "bun:test";

import { esDraftPropioPublicaciones } from "./push-ops";

// Publicaciones push-lane ownership (403-loop fix): the shared-browser RxDB
// can hold leftover `syncOpId` drafts from a previous user's login; only the
// owner's identity may push them.
describe("esDraftPropioPublicaciones", () => {
  const ID_USUARIO = "usuario-1";

  test("own draft passes the lane", () => {
    expect(esDraftPropioPublicaciones({ fkAgricultor: ID_USUARIO }, ID_USUARIO)).toBe(true);
  });

  test("foreign draft is kept out of the lane", () => {
    expect(esDraftPropioPublicaciones({ fkAgricultor: "usuario-2" }, ID_USUARIO)).toBe(false);
  });

  test("draft without a known owner is kept out (strict)", () => {
    expect(esDraftPropioPublicaciones({ fkAgricultor: null }, ID_USUARIO)).toBe(false);
  });
});
