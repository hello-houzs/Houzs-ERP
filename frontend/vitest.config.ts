import { defineConfig, mergeConfig, type UserConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Reuse the app's own resolve.alias (@2990s/*, the SCM vendor shims, the
// pinned zod) so a component test resolves imports exactly like the build
// does — a second, hand-maintained alias list is how test-only drift starts.
export default defineConfig(async (env) => {
  const base = (await (viteConfig as any)(env)) as UserConfig;
  return mergeConfig(base, {
    test: {
      environment: "jsdom",
      globals: false,
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  } as UserConfig);
});
