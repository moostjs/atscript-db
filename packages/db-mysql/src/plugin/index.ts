import type { TAtscriptPlugin } from "@atscript/core";

import { annotations } from "./annotations";

export const MysqlPlugin: () => TAtscriptPlugin = () => ({
  name: "mysql",

  config() {
    return {
      annotations: {
        db: {
          mysql: annotations,
        },
      },
    };
  },
});

export { MysqlPlugin as default };
