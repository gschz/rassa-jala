// ISO 8601 week-calendar helpers (Q-25: weeks 1–53, the ciclo is identified by its
// Monday date) with the business timezone America/Mazatlan (Q-22). Pure functions —
// no I/O, no dependencies; safe to import from the API, the seed and the web client
// (subpath import "@rassa-jala/db/iso-semana" avoids pulling Prisma into the bundle).

export const ZONA_NEGOCIO = "America/Mazatlan" as const;

export const ESTADO_PUBLICACION = {
  BORRADOR: "borrador",
  PUBLICADO: "publicado",
  CERRADO: "cerrado",
  CANCELADO: "cancelado",
} as const;
export type EstadoPublicacion = (typeof ESTADO_PUBLICACION)[keyof typeof ESTADO_PUBLICACION];

export const ESTADO_ITEM_SEMANAL = {
  ACTIVO: "activo",
  INACTIVO: "inactivo",
} as const;
export type EstadoItemSemanal = (typeof ESTADO_ITEM_SEMANAL)[keyof typeof ESTADO_ITEM_SEMANAL];

/** Parses 'YYYY-MM-DD' into the calendar date anchored at UTC midnight. */
export function parseFechaCiclo(fecha: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) throw new Error(`Fecha de ciclo inválida: ${fecha}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Serializes a UTC-anchored calendar date (Prisma @db.Date) back to 'YYYY-MM-DD'. */
export function aFechaCiclo(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

/** Calendar date 'YYYY-MM-DD' of `now` in the business timezone (Intl offset math). */
export function hoyNegocio(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_NEGOCIO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Monday of the business week containing `now` (UTC-anchored Date). */
export function mondayOfBusinessWeek(now: Date): Date {
  const hoy = parseFechaCiclo(hoyNegocio(now));
  // Mon=0..Sun=6 → step back to the week's Monday.
  const desplazamiento = (hoy.getUTCDay() + 6) % 7;
  const lunes = new Date(hoy);
  lunes.setUTCDate(lunes.getUTCDate() - desplazamiento);
  return lunes;
}

/** Is business "today" (America/Mazatlan) a Monday? (Monday-gate, Pu1/Q-25.) */
export function esLunesNegocio(now: Date): boolean {
  return parseFechaCiclo(hoyNegocio(now)).getUTCDay() === 1;
}

/** Is the 'YYYY-MM-DD' calendar date a Monday? */
export function esLunesFecha(fecha: string): boolean {
  return parseFechaCiclo(fecha).getUTCDay() === 1;
}

function lunesDeSemana(fecha: Date): Date {
  const lunes = new Date(fecha);
  lunes.setUTCDate(lunes.getUTCDate() - ((lunes.getUTCDay() + 6) % 7));
  return lunes;
}

/**
 * ISO week (1–53) + ISO week-year derived from a date of the week (normally its
 * Monday). ISO 8601 rule: the year is the one owning the week's Thursday; week 1
 * contains Jan 4. Tolerates a non-Monday input by normalizing to the week's Monday.
 */
export function isoWeekFromMonday(lunes: Date): { semanaIso: number; anioIso: number } {
  const jueves = lunesDeSemana(lunes);
  jueves.setUTCDate(jueves.getUTCDate() + 3);
  const anioIso = jueves.getUTCFullYear();
  const ene4 = new Date(Date.UTC(anioIso, 0, 4));
  const lunesSemana1 = lunesDeSemana(ene4);
  const semanaIso =
    1 + Math.round((lunesDeSemana(lunes).getTime() - lunesSemana1.getTime()) / (7 * 86_400_000));
  return { anioIso, semanaIso };
}
