import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev-server proxy rules.
//
// The frontend bundle calls the Cloudflare Worker at relative paths
// (/api/*, /portal/*, /track, /survey/*). In production those paths
// are served by the same origin as the bundle (via the Pages/Worker
// routing you already have). In `vite dev` there's nothing listening
// on those paths, so Vite returns the SPA index.html — which then
// parses as HTML and throws:
//   "Unexpected token '<', '<!doctype'... is not valid JSON"
//
// The proxy below forwards those paths to the Worker so dev works
// identically to production. Override the target via .env:
//
//   VITE_DEV_API_PROXY_TARGET=http://localhost:8787    # wrangler dev
//   VITE_DEV_API_PROXY_TARGET=https://autocount-sync-api.houzs-erp.workers.dev
//
// Default points at the deployed worker so `npm run dev` is usable
// with zero config as long as you're happy hitting remote.
export default defineConfig(({ mode }) => {
  // loadEnv reads from the current working directory; Vite always
  // runs from the project root so "" is correct. Using "" avoids
  // the Node-typed `process.cwd()` which tsc without @types/node
  // can't type-check.
  const env = loadEnv(mode, "", "");
  const target =
    env.VITE_DEV_API_PROXY_TARGET ||
    "https://autocount-sync-api.houzs-erp.workers.dev";

  const proxyRule = {
    target,
    changeOrigin: true,
    secure: true,
  };

  return {
    plugins: [react()],
    server: {
      proxy: {
        // Only /api/* gets forwarded. SPA routes (/track,
        // /portal/case/:token, /survey/:token, etc.) fall through to
        // Vite so index.html + React Router handle them.
        "/api": proxyRule,
      },
    },
  };
});
