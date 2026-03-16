import type { TAtscriptPlugin } from "@atscript/core";

import { annotations } from "./annotations";
import { primitives } from "./primitives";

export const MongoPlugin: () => TAtscriptPlugin = () => ({
  name: "mongo",

  config() {
    return {
      primitives,
      annotations: {
        db: {
          mongo: annotations,
        },
      },
    };
  },
});

export { MongoPlugin as default };
