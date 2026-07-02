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
      // Array form (find/replacement) — required because the react-router
      // entry uses a regex find; Vite forbids mixing object-map + array forms.
      alias: [
        // Pin the bare `zod` import to this app's own copy so Rollup resolves
        // it deterministically on a clean CI build. Exact-match so it doesn't
        // also rewrite e.g. "zod/lib".
        {
          find: /^zod$/,
          replacement: fileURLToPath(new URL("./node_modules/zod", import.meta.url)),
        },
        // ── Vendored 2990's SCM slice (Suppliers proof of concept) ──
        // The wholesale-copied 2990 pages/components import these bare
        // specifiers; map them onto the vendored copies under src/vendor.
        {
          find: /^@2990s\/design-system$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/design-system/index.ts", import.meta.url)
          ),
        },
        // @2990s/shared/phone + /mfg-pricing (subpaths) MUST precede
        // @2990s/shared so the longer specifier matches first.
        {
          find: /^@2990s\/shared\/phone$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/phone.ts", import.meta.url)
          ),
        },
        // @2990s/shared/mfg-pricing — the PO pages import the cost engine
        // (computeMfgPoUnitCost) via this dedicated subpath, matching 2990's.
        {
          find: /^@2990s\/shared\/mfg-pricing$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/mfg-pricing.ts", import.meta.url)
          ),
        },
        // @2990s/shared/payment-methods — the SO PaymentsTable + SO Maintenance
        // page branch on the L1 method vocabulary via this dedicated subpath.
        {
          find: /^@2990s\/shared\/payment-methods$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/scm/lib/payment-methods.ts", import.meta.url)
          ),
        },
        // @2990s/shared/so-variant-rule — SoLineCard + the sales-order/* types
        // import the required-variant rule via this dedicated subpath (it's also
        // re-exported by the @2990s/shared barrel, but the source uses the
        // subpath, so keep it verbatim).
        {
          find: /^@2990s\/shared\/so-variant-rule$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/so-variant-rule.ts", import.meta.url)
          ),
        },
        // @2990s/shared/so-line-display — the real PDF generators (PO/GRN/PI/PR/
        // SO/DO/DR/SI) import the canonical SO line ordering + PWP note helpers
        // via this dedicated subpath, matching 2990's source.
        {
          find: /^@2990s\/shared\/so-line-display$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/so-line-display.ts", import.meta.url)
          ),
        },
        {
          find: /^@2990s\/shared$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/index.ts", import.meta.url)
          ),
        },
        // NOTE on 'react-router': the vendored 2990 pages import router bits
        // (useNavigate/useParams/Navigate) from the bare 'react-router'
        // specifier. No alias is needed — react-router v6.30 is already present
        // in node_modules as react-router-dom's own dependency and re-exports
        // those same hooks. (An earlier alias to react-router-dom broke the
        // build by rewriting react-router-dom's INTERNAL self-imports.)
        // DataGrid imports useVirtualizer from @tanstack/react-virtual, which
        // is NOT installed here (no npm install allowed). A dependency-free
        // shim reimplements the exact slice DataGrid uses.
        {
          find: /^@tanstack\/react-virtual$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/scm/lib/react-virtual-shim.ts", import.meta.url)
          ),
        },
      ],
      // Force a single React/ReactDOM instance. The vendored 2990 modules
      // import router bits from the bare 'react-router' specifier, and as the
      // vendored graph grew Vite's dev dep-optimizer began splitting React into
      // two copies (symptom: "Invalid hook call" / useContext-of-null from
      // react-router's useNavigate). dedupe pins everything to one copy.
      dedupe: [
        "react",
        "react-dom",
        "react-router",
        "react-router-dom",
        // react-query is context-based too — a split copy makes the vendored
        // pages' useQuery miss the root QueryClientProvider ("No QueryClient set").
        "@tanstack/react-query",
      ],
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
            // xlsx + jspdf are heavy and only ever reached via dynamic
            // import() (SCM export / print handlers). Leaving them out of the
            // eager `vendor` chunk lets Rollup split them into on-demand chunks
            // loaded only when a user actually exports or prints.
            if (
              /[\\/]node_modules[\\/](xlsx|jspdf|jspdf-autotable)[\\/]/.test(id)
            )
              return;
            return "vendor";
          },
        },
      },
    },
    server: {
      // Pin dev to 5173 so `npm run dev` doesn't drift up to 5174 /
      // 5175 / 5180 when another Vite is already running. strictPort
      // fails fast instead of auto-picking a random free port, which
      // matters here because the PWA service worker is registered
      // per-origin and stale registrations on other ports serve
      // cached bundles.
      port: 5173,
      strictPort: true,
      proxy: {
        // Only /api/* gets forwarded. SPA routes (/track,
        // /portal/case/:token, /survey/:token, etc.) fall through to
        // Vite so index.html + React Router handle them.
        "/api": proxyRule,
      },
    },
  };
});
