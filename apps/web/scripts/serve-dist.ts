/**
 * Static server for apps/web/dist with SPA fallback — used to verify the PWA
 * offline cold start WITHOUT the API (P0-E). What the service worker's
 * navigateFallback does at runtime is emulated here so deep routes can be
 * curled directly. Test-only; not part of the app.
 */
const ROOT = new URL("../dist", import.meta.url).pathname;

Bun.serve({
  port: 4173,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const file = Bun.file(ROOT + (pathname === "/" ? "/index.html" : pathname));
    if (await file.exists()) return new Response(file);
    // SPA fallback (the SW navigateFallback equivalent for deep routes).
    return new Response(Bun.file(ROOT + "/index.html"));
  },
});
