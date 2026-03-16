import { defineConfig } from "@atscript/core";
import dbPlugin from "@atscript/db/plugin";
import MongoPlugin from "./src/plugin";
import ts from "@atscript/typescript";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin(), MongoPlugin()],
  format: "dts",
  unknownAnnotation: "warn",
});
