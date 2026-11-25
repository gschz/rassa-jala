import { describe, expect, test } from "bun:test";

import { decideRewind } from "./rewind";

describe("decideRewind (sync doc §4.2 rewind contract)", () => {
  test("checkpoint below head is NOT a rewind", () => {
    expect(decideRewind(41, 42)).toBe(false);
    expect(decideRewind(1, 2)).toBe(false);
  });

  test("checkpoint equal to head is NOT a rewind", () => {
    expect(decideRewind(42, 42)).toBe(false);
    expect(decideRewind(0, 0)).toBe(false);
  });

  test("checkpoint strictly ahead of head IS a rewind", () => {
    expect(decideRewind(43, 42)).toBe(true);
    expect(decideRewind(73006, 0)).toBe(true);
  });

  test("initial pull (null checkpoint) is never a rewind", () => {
    expect(decideRewind(null, 42)).toBe(false);
    expect(decideRewind(undefined, 42)).toBe(false);
  });

  test("missing head (older server) is never a rewind (backward compatible)", () => {
    expect(decideRewind(73006, null)).toBe(false);
    expect(decideRewind(73006, undefined)).toBe(false);
  });
});
