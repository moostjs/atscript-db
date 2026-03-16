import type { TAtscriptPlugin } from "@atscript/core";

import { annotations } from "./annotations";

export const PostgresPlugin: () => TAtscriptPlugin = () => ({
  name: "postgres",

  config() {
    return {
      annotations: {
        db: {
          pg: annotations,
        },
      },
    };
  },
});

export { PostgresPlugin as default };
