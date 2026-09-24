// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // A normal VPS runs the standalone Node server; other build targets retain their defaults.
  ...(process.env["ENCLAVE_DEPLOY_TARGET"] === "node" ? { nitro: { preset: "node-server" } } : {}),
  vite: {
    server: {
      proxy: {
        "/api": {
          target: process.env["ENCLAVE_API_URL"] || "http://127.0.0.1:8789",
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, ""),
        },
      },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
