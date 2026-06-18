import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

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
    resolve: {
      alias: {
        "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
        // shared/ lives at the repo root (out of this app's node_modules tree),
        // so Rollup can't resolve its bare `zod` import on a clean CI build.
        // Pin it to this app's own copy.
        zod: fileURLToPath(new URL("./node_modules/zod", import.meta.url)),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          // Stable vendor chunks so app-code changes don't bust the
          // cached framework bytes, and heavyweights (leaflet maps,
          // lucide icon set) live outside the entry bundle. Path-based
          // (not the object form) because the object form was leaking
          // react-dom into the entry `index` chunk, pushing it past the
          // bundle-size budget — matching by node_modules path reliably
          // pulls the framework out of the entry.
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (
              /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
                id
              ) ||
              id.includes("@tanstack")
            )
              return "react-vendor";
            if (id.includes("leaflet")) return "leaflet";
            if (id.includes("lucide-react")) return "lucide";
            return "vendor";
          },
        },
      },
    },
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
