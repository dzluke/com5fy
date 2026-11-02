// Build config for the com5fy frontend.
//
// ComfyUI serves custom-node JS from WEB_DIRECTORY ("./js") and imports EVERY
// `*.js` file under it (recursively) as an extension module. So the build emits:
//
//   ../js/com5fy.js        the single entry: registers all m5 extensions
//   ../js/chunks/*.mjs     lazily imported chunks (OSMD, VexFlow, ...). The
//                          `.mjs` extension keeps ComfyUI from importing them
//                          at startup; they load on first use, like the old
//                          vendored bundles did.
//
// ComfyUI's own modules (/scripts/app.js, /scripts/api.js) are external: they
// are provided by the running ComfyUI frontend, not bundled.
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "./",
  publicDir: false,
  build: {
    outDir: here("../js"),
    emptyOutDir: true,
    target: "es2022",
    // No <link rel=modulepreload> helper: there is no HTML page, and chunks
    // must resolve relative to com5fy.js wherever ComfyUI serves it from.
    modulePreload: false,
    // OSMD and VexFlow are ~1 MB each; they are lazy chunks, so that's fine.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: here("src/main.ts"),
      external: ["/scripts/app.js", "/scripts/api.js"],
      preserveEntrySignatures: "exports-only",
      output: {
        format: "es",
        entryFileNames: "com5fy.js",
        chunkFileNames: "chunks/[name].mjs",
        assetFileNames: "chunks/[name][extname]",
      },
    },
  },
});
