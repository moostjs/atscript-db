import atscriptVite from "unplugin-atscript/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [atscriptVite()],
  pack: {
    entry: ["src/index.ts", "src/validator.ts"],
    dts: true,
    format: ["esm", "cjs"],
    deps: {
      neverBundle: [/^@atscript\//, /^@uniqu\//],
    },
  },
});
