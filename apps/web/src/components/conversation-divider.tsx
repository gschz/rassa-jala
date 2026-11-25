import { Marker, MarkerContent } from "@rassa-jala/ui/components/marker";

/**
 * Conversation dividers (gap-pass-8 T5, chatcn conversation-divider style):
 * centered labels with rules on each side (Marker "separator") between message
 * groups. Message instants are UTC; the WALL DAY groups in America/Mazatlan —
 * the same business-day rule as the dashboard and the API.
 */

const TZ = "America/Mazatlan";

const fmtDia = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const fmtFechaLarga = new Intl.DateTimeFormat("es-MX", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** Mazatlan wall-day key ("YYYY-MM-DD") of an instant — day-grouping key for the timeline. */
export function diaMazatlan(instante: string | number | Date): string {
  return fmtDia.format(typeof instante === "string" ? new Date(instante) : instante);
}

const diaAEpoca = (dia: string): number => Math.round(Date.parse(`${dia}T00:00:00Z`) / 86_400_000);

/** "Hoy" / "Ayer" / "lun 12 oct" — relative label for a message's wall day. */
export function etiquetaDiaRelativo(creadoEn: string, ahora: string | number | Date): string {
  const diff = diaAEpoca(diaMazatlan(creadoEn)) - diaAEpoca(diaMazatlan(ahora));
  if (diff === 0) return "Hoy";
  if (diff === -1) return "Ayer";
  return fmtFechaLarga.format(new Date(creadoEn));
}

/** Date divider between wall-day groups of messages. */
export function DividerFecha({
  creadoEn,
  ahora,
}: Readonly<{ creadoEn: string; ahora: string | number | Date }>) {
  return (
    <Marker variant="separator" className="text-[11px]">
      <MarkerContent>{etiquetaDiaRelativo(creadoEn, ahora)}</MarkerContent>
    </Marker>
  );
}

/** Unread divider (accent-colored, chatcn style) before the first unseen incoming message. */
export function DividerNoLeidos({ cantidad }: Readonly<{ cantidad: number }>) {
  return (
    <Marker variant="separator" className="font-medium text-primary">
      <MarkerContent>
        · {cantidad === 1 ? "1 mensaje nuevo" : `${cantidad} mensajes nuevos`} ·
      </MarkerContent>
    </Marker>
  );
}

// --- client-side "seen" marker (cosmetic only; the server `leido` F13 stays the owner of read state) ---

const CLAVE_MARCA = "rassa.chat.visto";

function leerMarcas(): Record<string, string> {
  try {
    const crudo = localStorage.getItem(CLAVE_MARCA);
    return crudo ? (JSON.parse(crudo) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Last seen instant (ISO) recorded for a conversation, or null on first visit. */
export function leerMarcaVisto(idConversacion: string): string | null {
  return leerMarcas()[idConversacion] ?? null;
}

/** Records the last seen instant for a conversation (best-effort; the divider is cosmetic). */
export function guardarMarcaVisto(idConversacion: string, vistoEn: string): void {
  try {
    localStorage.setItem(
      CLAVE_MARCA,
      JSON.stringify({ ...leerMarcas(), [idConversacion]: vistoEn }),
    );
  } catch {
    // storage blocked/full: skip the marker — the divider is presentation only.
  }
}
