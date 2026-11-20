/**
 * Global teardown for the e2e server fixture (wired via apps/web/bunfig.toml).
 *
 * Why a preload: `bun test` does not run `process.on("exit")` or `beforeExit`
 * hooks (verified on bun 1.4.4), so an exit hook alone leaves the spawned
 * server orphaned. A global `afterAll` registered from a preload module is the
 * only hook that runs after the LAST test file of the whole run.
 *
 * helpers.ts publishes the stop function on globalThis when it spawns, so this
 * module never imports helpers (unit-test runs pay nothing).
 */
import { afterAll } from "bun:test";

afterAll(() => {
  (globalThis as { __rassaE2EStopServer?: () => void }).__rassaE2EStopServer?.();
});
