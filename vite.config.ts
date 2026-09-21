import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["**/*.as.d.ts", "**/atscript.d.ts", "**/*.gen.ts"],
  },
  lint: {
    ignorePatterns: ["**/*.as", "docs/**"],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
      style: "off",
      pedantic: "off",
      restriction: "off",
      nursery: "off",
    },
    options: { typeAware: true, typeCheck: true },
    rules: {
      // House style: `_`-prefixed members are how every class here marks its
      // internals. The rule is `restriction`/`style` (both "off" above) yet
      // still fires ~1950 times, and that output volume is enough to crash
      // `vp check` when the pre-commit hook pipes it.
      "no-underscore-dangle": "off",
      "no-unsafe-type-assertion": "off",
      "no-await-in-loop": "off",
      "no-new": "off",
      "no-unnecessary-type-assertion": "off",
      "no-misused-spread": "off",
      "no-shadow": "off",
    },
  },
});
