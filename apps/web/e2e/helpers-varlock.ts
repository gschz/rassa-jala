// Static order matters: helpers-env sets the test env overrides FIRST (its module
// body is synchronous), then varlock's runtime loader initializes from process.env
// — so the override wins over apps/web/.env (verified: pre-init assignment wins).
import "./helpers-env";
import "varlock/auto-load";
