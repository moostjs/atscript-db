import { defineConfig } from "@atscript/core";
import dbPlugin from "@atscript/db/plugin";
import { PostgresPlugin } from "./src/plugin";
import ts from "@atscript/typescript";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin(), PostgresPlugin()],
  format: "dts",
  unknownAnnotation: "warn",
});
