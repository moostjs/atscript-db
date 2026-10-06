import { AnnotationSpec, defineConfig } from "@atscript/core";
import dbPlugin from "@atscript/db/plugin";
import ts from "@atscript/typescript";

// Test-only: stands in for a binding annotation with a ref argument (such as
// `@ui.valueHelp`), which moost-db itself never names — see
// `src/__test__/meta-annotation-refs.spec.ts`.
const refBindingTestPlugin = {
  name: "ref-binding-test",
  config() {
    return {
      annotations: {
        vhx: {
          bind: new AnnotationSpec({
            nodeType: ["prop", "type"],
            argument: [
              { name: "target", type: "ref" },
              { name: "field", type: "string" },
            ],
          }),
        },
      },
    };
  },
};

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin(), refBindingTestPlugin],
  format: "dts",
  unknownAnnotation: "warn",
});
