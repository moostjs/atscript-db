import atscriptRolldown from "unplugin-atscript/rolldown";
import atscriptVite from "unplugin-atscript/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [atscriptVite()],
  pack: {
    entry: ["src/index.ts", "src/plugin.ts", "src/agg.ts"],
    dts: true,
    format: ["esm", "cjs"],
    plugins: [atscriptRolldown()],
    inputOptions: {
      onwarn(warning, defaultHandler) {
        if (warning.code === "MIXED_EXPORTS") return;
        defaultHandler(warning);
      },
    },
  },
});
