import { toast } from "sonner";

// Network failures (offline, tunnel down, ngrok interstitial) surface as a TypeError
// from fetch; tRPC's httpBatchLink wraps it in TRPCClientError keeping the original
// as `.cause` — so detection walks the cause chain. sonner's `id` dedupes N failed
// queries into a single toast.
const ID_RED = "sin-conexion-servidor";
const MENSAJE_RED =
  "Sin conexión con el servidor. Tus datos guardados siguen disponibles y se sincronizarán al reconectar.";

// Browser messages: Chrome "Failed to fetch", Firefox "NetworkError...", Safari
// "Load failed"; Bun/undici: "fetch failed" / "ECONNREFUSED...". Cause chains nest
// shallowly — the walk is bounded.
const PATRON_RED = /failed to fetch|networkerror|load failed|econnrefused|fetch failed/i;

export function esErrorDeRed(error: unknown): boolean {
  let actual: unknown = error;
  for (let profundidad = 0; profundidad < 5; profundidad++) {
    if (!(actual instanceof Error)) return false;
    if (PATRON_RED.test(actual.message)) return true;
    actual = (actual as Error & { cause?: unknown }).cause;
  }
  return false;
}

export function mensajeDeError(error: unknown): string {
  if (esErrorDeRed(error)) return MENSAJE_RED;
  if (error instanceof Error) return error.message;
  return "Ocurrió un error inesperado.";
}

export function notificarError(error: unknown): void {
  if (esErrorDeRed(error)) {
    toast.error(MENSAJE_RED, { id: ID_RED, duration: 6000 });
    return;
  }
  toast.error(mensajeDeError(error));
}
