/**
 * Test-side env pre-init (MUST run before varlock loads apps/web/.env, which pins
 * VITE_SERVER_URL to the dev server on :3000). Synchronous module body, NO imports:
 * bun evaluates an importer's sibling static imports while a top-level-await
 * dependency is still pending (verified), so any `await import` here would let
 * sync-client's module body read ENV before varlock initializes.
 */
process.env.VITE_SERVER_URL ??= "http://localhost:3010";
