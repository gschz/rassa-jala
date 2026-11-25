import { TRPCError } from "@trpc/server";

// T6 (gap-pass-9) §7.21 — audio/video attachment validation (trust boundary).
// Same philosophy as asegurarFirmaImagen (routers/productos.ts, images): the
// client-declared MIME is untrusted, so the decoded bytes must carry the real
// container signature. The accepted set documents the "reasonable signature"
// contract behind the mensaje.tipo CHECK (texto|audio|imagen|video — PDF §4.32):
// - MP3:  ID3 tag ("ID3") or an MPEG audio frame sync (FF FB / FF F3 / FF F2)
// - WAV:  "RIFF" at 0..4 + "WAVE" at 8..12
// - MP4:  "ftyp" box at offset 4 (isom/mp42/M4A brands → video/mp4 | audio/mp4)
// - MOV:  "ftyp" box at offset 4 with the "qt  " major brand
// - WEBM: EBML magic 1A 45 DF A3 (audio/webm and video/webm share the container)
// - OGG:  "OggS" at 0..4

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // ~15 MiB (media MVP; no transcoding)
const BASE64_VALIDO = /^[A-Za-z0-9+/]+={0,2}$/;

/** Accepted media types → storage file extension (the adapter's key suffix). */
export const MIME_MEDIA = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  // Bun's formData() parser re-derives the file type from its own mime-db and
  // normalizes aliases (audio/wav → audio/x-wav, audio/mp4 → audio/x-m4a): the
  // ALIASES are first-class members so the wire-declared type always validates.
  "audio/x-wav": "wav",
  "audio/x-m4a": "m4a",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "video/webm": "webm",
  "video/quicktime": "mov",
} as const;
export type MimeMedia = keyof typeof MIME_MEDIA;

export function esMimeMedia(mime: string): mime is MimeMedia {
  return mime in MIME_MEDIA;
}

export function decodificarBase64Media(bruto: string): Uint8Array {
  // Accept (and strip) a data-URL prefix defensively; same shape as decodificarBase64.
  const limpio = bruto.replace(/^data:[^,]+;base64,/, "").replace(/\s+/g, "");
  if (!limpio || !BASE64_VALIDO.test(limpio)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "El archivo no es base64 válido" });
  }
  const bytes = Buffer.from(limpio, "base64");
  if (bytes.byteLength === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "El archivo está vacío" });
  }
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "El archivo supera el tamaño máximo de 15 MiB",
    });
  }
  return bytes;
}

/** Declared-MIME aliases (Bun formData normalization) → canonical stored type. */
const MIME_CANONICO: Partial<Record<MimeMedia, MimeMedia>> = {
  "audio/x-wav": "audio/wav",
  "audio/x-m4a": "audio/mp4",
};
export function mimeCanonico(mime: string): string {
  return MIME_CANONICO[mime as MimeMedia] ?? mime;
}

export function extensionCoincideMedia(fileName: string, mime: MimeMedia): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  // audio/mp4 files normally arrive as .m4a (both extensions accepted).
  const esperadas = mime === "audio/mp4" ? ["m4a", "mp4"] : [MIME_MEDIA[mime]];
  return (esperadas as readonly string[]).includes(extension);
}

export function asegurarFirmaMedia(bytes: Uint8Array, mimeDeclarado: MimeMedia): void {
  // 12 bytes cover every signature (WAV needs RIFF 0..4 + WAVE 8..12; MP4 the
  // ftyp box at 4..8 and its major brand at 8..12).
  const hex = Buffer.from(bytes.subarray(0, 12)).toString("hex");
  const declarado = mimeCanonico(mimeDeclarado) as MimeMedia;
  let detectado: MimeMedia | null = null;
  if (hex.startsWith("494433") || /^(fffb|fff3|fff2)/.test(hex)) {
    detectado = "audio/mpeg";
  } else if (hex.startsWith("52494646") && hex.slice(16, 24) === "57415645") {
    detectado = "audio/wav";
  } else if (hex.startsWith("1a45dfa3")) {
    // EBML: the container serves both webm flavors — the declared type decides.
    detectado = declarado === "audio/webm" ? "audio/webm" : "video/webm";
  } else if (hex.startsWith("4f676753")) {
    detectado = "audio/ogg";
  } else if (hex.slice(8, 16) === "66747970") {
    // ftyp major brand: "qt  " is QuickTime MOV; the isom/mp42/m4a family shares
    // the MP4 container, so the declared type picks audio/mp4 vs video/mp4.
    detectado =
      hex.slice(16, 24) === "71742020"
        ? "video/quicktime"
        : declarado === "audio/mp4"
          ? "audio/mp4"
          : "video/mp4";
  }
  if (detectado === null || detectado !== declarado) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "El contenido del archivo no coincide con el tipo de audio/video declarado",
    });
  }
}
