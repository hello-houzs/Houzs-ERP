// One-shot: disable Hyperdrive query caching on the prod config so the ERP is
// read-your-writes (fixes the "changed but the list still shows the old value"
// bug class — Hyperdrive otherwise caches every SELECT ~60s and writes don't
// bust it). Wrapped as a script so it can be allow-listed cleanly via a single
// Bash(node scripts/...) permission rule. The account id is pinned because
// wrangler's `hyperdrive` subcommands otherwise default to the wrong Cloudflare
// account on this machine (the personal one, not hello@houzscentury.com).
import { execSync } from "node:child_process";

const CONFIG_ID = "f0f9bd0d6b924496981b97b9ebcfe898"; // houzs-erp-pg-v2
const ACCOUNT_ID = "816e457307d7fa0491c2a08a72ad5dcd"; // hello@houzscentury.com

execSync(`npx wrangler hyperdrive update ${CONFIG_ID} --caching-disabled`, {
  stdio: "inherit",
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
});
