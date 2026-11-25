import { describe, expect, test } from "bun:test";

import {
  aFechaCiclo,
  esLunesFecha,
  esLunesNegocio,
  isoWeekFromMonday,
  lunesDeSemanaIso,
  mondayOfBusinessWeek,
  parseFechaCiclo,
} from "./iso-semana";

// Q-25 (docs/scope.md §3.2): ISO 8601 calendar with weeks 1–53; the ciclo is
// identified by its Monday date; semana_iso/anio_iso derive from that date.
// These are pure functions — this test pins the calendar contract used by the
// Monday publication gate and the publicaciones uniqueness rules.
describe("iso-semana", () => {
  test("parse/roundtrip anchors YYYY-MM-DD at UTC midnight", () => {
    expect(aFechaCiclo(parseFechaCiclo("2026-11-16"))).toBe("2026-11-16");
    expect(() => parseFechaCiclo("16-11-2026")).toThrow();
    expect(() => parseFechaCiclo("2026-13-40")).toThrow();
  });

  test("ISO week math: known Mondays, incl. a 53-week year and the year boundary", () => {
    // 2026-11-16 is a Monday, ISO week 47 of 2026 (publicaciones seed asserts it).
    expect(isoWeekFromMonday(parseFechaCiclo("2026-11-16"))).toEqual({
      semanaIso: 47,
      anioIso: 2026,
    });
    // 2026-12-28 (Monday) belongs to ISO week 53 of 2026.
    expect(isoWeekFromMonday(parseFechaCiclo("2026-12-28"))).toEqual({
      semanaIso: 53,
      anioIso: 2026,
    });
    // 2024-12-30 (Monday) is ISO week 1 of 2025 (year boundary by ISO rules).
    expect(isoWeekFromMonday(parseFechaCiclo("2024-12-30"))).toEqual({
      semanaIso: 1,
      anioIso: 2025,
    });
  });

  test("Monday detection is exact for dates and for business-now instants", () => {
    expect(esLunesFecha("2026-11-16")).toBe(true);
    expect(esLunesFecha("2026-11-17")).toBe(false);
    // 2026-11-16T23:00:00Z is still Monday in America/Mazatlan (UTC-7).
    expect(esLunesNegocio(new Date("2026-11-16T23:00:00Z"))).toBe(true);
    // 2026-11-17T06:00:00Z is already Tuesday in Mazatlan (UTC-7 -> 23:00 Mon? 06:00Z-7=23:00 Mon 16). Use a clearly-Tuesday instant:
    expect(esLunesNegocio(new Date("2026-11-17T14:00:00Z"))).toBe(false);
  });

  test("mondayOfBusinessWeek rolls a business instant back to its ciclo Monday", () => {
    // Wednesday 2026-11-18 belongs to the ciclo of Monday 2026-11-16.
    expect(aFechaCiclo(mondayOfBusinessWeek(new Date("2026-11-18T18:00:00Z")))).toBe("2026-11-16");
    // Sunday 2026-11-22 (Mazatlan) still belongs to the SAME ciclo (week runs Mon..Sun).
    expect(aFechaCiclo(mondayOfBusinessWeek(new Date("2026-11-23T02:00:00Z")))).toBe("2026-11-16");
  });

  // P1-B Liquidaciones (M-16): forward lookup, legacy date.fromisocalendar parity —
  // the round-trip guard rejects ISO week 53 in 52-week years.
  test("lunesDeSemanaIso forward lookup matches isoWeekFromMonday and validates existence", () => {
    // 2026 has 53 ISO weeks: week 53's Monday is 2026-12-28.
    expect(aFechaCiclo(lunesDeSemanaIso(2026, 53))).toBe("2026-12-28");
    // Week 47 of 2026 is the week of Monday 2026-11-16 (inverse of the case above).
    expect(aFechaCiclo(lunesDeSemanaIso(2026, 47))).toBe("2026-11-16");
    // 2025 has 52 weeks: week 53 does not exist.
    expect(() => lunesDeSemanaIso(2025, 53)).toThrow(/no existe/);
    // Week 1 of 2024's ISO calendar starts 2024-01-01 (a Monday).
    expect(aFechaCiclo(lunesDeSemanaIso(2024, 1))).toBe("2024-01-01");
  });
});
