import { defineConfig } from "@atscript/core";
import dbPlugin from "./src/plugin";
import ts from "@atscript/typescript";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin()],
  format: "dts",
  unknownAnnotation: "warn",
});
