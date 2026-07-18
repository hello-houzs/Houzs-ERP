import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

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

  // One id per build. Used for BOTH the localStorage snapshot namespace
  // (__BUILD_ID__ define) and the service-worker cache VERSION (stamped into
  // dist/sw.js below), so a deploy can never accidentally reuse either.
  const buildId = Date.now().toString(36);

  /* Native (Capacitor) build defaults, applied by `vite build --mode native`.
     These would normally live in .env.native, but .env* is gitignored and
     weakening that rule to admit one file is how a secret eventually leaks.
     None of these is secret -- they are the public URLs the browser already
     talks to -- and a shipped binary cannot be reconfigured afterwards, so the
     values it was built with belong somewhere reviewable rather than in one
     person's CI settings. An explicitly-set env var still wins, which is what
     a staging build would use. */
  const nativeDefines =
    mode === "native"
      ? {
          // capacitor://localhost gives /api/* nothing to be relative to. Points
          // at the PAGES origin, not the Worker: *.workers.dev is intermittently
          // blocked by Malaysian carriers (2026-07-09 driver login timeouts) and
          // the Pages Function proxy is the fix.
          "import.meta.env.VITE_API_URL": JSON.stringify(
            env.VITE_API_URL || "https://erp.houzscentury.com"
          ),
          // Links that LEAVE the app: portal cases, invites, password resets.
          "import.meta.env.VITE_PUBLIC_WEB_ORIGIN": JSON.stringify(
            env.VITE_PUBLIC_WEB_ORIGIN || "https://erp.houzscentury.com"
          ),
          // Pre-auth company identity; the web infers it from the hostname,
          // which a native shell can never satisfy.
          "import.meta.env.VITE_DEFAULT_COMPANY_CODE": JSON.stringify(
            env.VITE_DEFAULT_COMPANY_CODE || "HOUZS"
          ),
        }
      : {};

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
    plugins: [
      react(),
      // Stamp the build id into dist/sw.js (replacing the __SW_BUILD_ID__ token)
      // so the service-worker cache VERSION is unique per deploy → the SW's
      // activate step purges the previous deploy's caches automatically. Removes
      // the manual sw.js VERSION bump (forgotten bumps served a stale shell;
      // parallel branches even collided on the same vNNN). writeBundle only fires
      // on build, so dev (which doesn't register the SW) is unaffected.
      {
        name: "sw-build-version",
        writeBundle() {
          try {
            const swPath = fileURLToPath(new URL("./dist/sw.js", import.meta.url));
            if (existsSync(swPath)) {
              writeFileSync(
                swPath,
                readFileSync(swPath, "utf8").replace(/__SW_BUILD_ID__/g, buildId),
              );
            }
          } catch (e) {
            console.warn("[sw-build-version] could not stamp sw.js:", e);
          }
        },
      },
    ],
    // Unique per build — namespaces the localStorage query snapshot
    // (src/lib/query-persist.ts) so a deploy that changes a list's payload shape
    // orphans the previous build's snapshot instead of hydrating a stale shape.
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      ...nativeDefines,
    },
    build: {
      // Don't <link rel="modulepreload"> the heavy on-demand chunks (jspdf /
      // xlsx / leaflet). They're only ever reached via dynamic import() at a
      // print/export/map click, so preloading them makes a COLD first visit
      // eagerly download ~1MB of JS almost no session uses. Filtering them out of
      // the preload graph (they still load on demand) is a pure cold-load win —
      // HOOKKA's resolveDependencies trick.
      modulePreload: {
        resolveDependencies: (_filename, deps) =>
          deps.filter((d) => !/(jspdf|xlsx|leaflet)/i.test(d)),
      },
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
            // Everything else: let Rollup assign the chunk from what actually
            // reaches the module.
            //
            // This used to be `return "vendor"`, which was a correctness bug,
            // not just a packaging choice. The rule above it excluded xlsx and
            // jspdf BY PACKAGE NAME so they would stay on-demand — but their
            // dependencies are separate node_modules directories, so the names
            // never matched them and they fell through to `vendor`. jspdf's
            // tree alone (dompurify, html2canvas, canvg, core-js, fflate,
            // @babel/runtime, ...) is most of that chunk's ~394 KB raw /
            // 117 KB gzip. And `vendor` IS eager: @remix-run/router lands
            // there too (react-router-dom's own dependency, matched by neither
            // name above), so the entry graph pulls the chunk in and every
            // cold load paid for a PDF stack that only a print click reaches.
            // Co-locating a lazy-only module with an eager one is what makes
            // it eager — the exclusion list defeated itself.
            //
            // Naming the transitive deps here instead would just re-arm the
            // same trap on the next dependency bump. Reachability is the thing
            // we actually mean, and Rollup computes it for free.
            return;
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
