import { defineConfig } from "@atscript/core";
import dbPlugin from "@atscript/db/plugin";
import { MysqlPlugin } from "./src/plugin";
import ts from "@atscript/typescript";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin(), MysqlPlugin()],
  format: "dts",
  unknownAnnotation: "warn",
});
