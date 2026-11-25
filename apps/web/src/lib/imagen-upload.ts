import { authFetch } from "@/lib/auth/http";
import { getServerUrl } from "@/lib/server-url";

/** Client-side mirrors of the server's upload contract (trust boundary is server-side). */
const MAX_IMAGEN_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const MIME_IMAGEN = new Set(["image/png", "image/jpeg", "image/webp"]);
// T6 (gap-pass-9): chat media attachments — same accepted set as MIME_MEDIA server-side.
const MIME_MEDIA = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "video/mp4",
  "audio/ogg",
  "audio/webm",
  "video/webm",
  "video/quicktime",
]);

/**
 * Destination of an image upload: the master catalog (Admin) or a weekly item photo
 * (farmer-owned). Both are served by POST /upload/imagenes, which bridges into the
 * productos.imagenes.upload / publicaciones.imagenes.upload procedures server-side.
 */
export type DestinoImagen =
  | { tipo: "producto"; fkProducto: string }
  | { tipo: "item"; fkProductoSemanal: string };

/**
 * Multipart image upload (gap 3: the wire no longer carries base64-in-JSON). The
 * client-side MIME/size pre-checks surface the same feedback the server enforces.
 * authFetch carries the Bearer token + silent refresh; error responses arrive as
 * { error } JSON with an HTTP status, surfaced as a thrown Error for useMutation.
 */
export async function subirImagenMultipart(destino: DestinoImagen, archivo: File): Promise<void> {
  if (!MIME_IMAGEN.has(archivo.type)) {
    throw new Error("Formato no permitido: usa PNG, JPG o WebP");
  }
  if (archivo.size > MAX_IMAGEN_BYTES) {
    throw new Error("La imagen supera el tamaño máximo de 5 MiB");
  }
  const form = new FormData();
  form.append("file", archivo, archivo.name);
  if (destino.tipo === "producto") form.append("fkProducto", destino.fkProducto);
  else form.append("fkProductoSemanal", destino.fkProductoSemanal);
  const res = await authFetch(`${getServerUrl()}/upload/imagenes`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `No se pudo subir la imagen (HTTP ${res.status})`);
  }
}

/** T6: the mensaje.tipo an attachment's MIME maps to (texto is the no-attachment case). */
export function tipoMensajeDeAdjunto(archivo: File): "imagen" | "audio" | "video" | null {
  if (MIME_IMAGEN.has(archivo.type)) return "imagen";
  if (archivo.type.startsWith("audio/")) return "audio";
  if (archivo.type.startsWith("video/")) return "video";
  return null;
}

/**
 * T17/T6 chat attachment upload: multipart POST /upload/documentos (the server
 * bridges into chat.documentos.upload — image/media signatures validated
 * server-side, a `documento` row persisted). Returns the persisted reference the
 * message carries: `url` (the /storage/... path that goes into mensaje.archivoUrl)
 * + id + storageKey. ONLINE-ONLY by nature: an attachment cannot be created while
 * offline (the chat UI disables the attach button; text drafts keep the offline path).
 */
export async function subirArchivoChat(
  archivo: File,
): Promise<{ id: string; url: string; storageKey: string }> {
  const esImagen = MIME_IMAGEN.has(archivo.type);
  const esMedia = MIME_MEDIA.has(archivo.type);
  if (!esImagen && !esMedia) {
    throw new Error("Formato no permitido: usa imagen (PNG, JPG, WebP), audio o video");
  }
  if (archivo.size > (esImagen ? MAX_IMAGEN_BYTES : MAX_MEDIA_BYTES)) {
    throw new Error(
      esImagen
        ? "La imagen supera el tamaño máximo de 5 MiB"
        : "El archivo supera el tamaño máximo de 15 MiB",
    );
  }
  const form = new FormData();
  form.append("file", archivo, archivo.name);
  const res = await authFetch(`${getServerUrl()}/upload/documentos`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `No se pudo subir el archivo (HTTP ${res.status})`);
  }
  return (await res.json()) as { id: string; url: string; storageKey: string };
}
