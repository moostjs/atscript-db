import { annotationExample } from "@atscript/core";
import type { TAtscriptConfig } from "@atscript/core";
export const primitives: TAtscriptConfig["primitives"] = {
  mongo: {
    extensions: {
      objectId: {
        type: "string",
        documentation: annotationExample(
          "Represents a **MongoDB ObjectId**.\n\n" +
            "- Stored as a **string** but can be converted to an ObjectId at runtime.\n" +
            "- Useful for handling `_id` fields and queries that require ObjectId conversion.\n" +
            "- Automatically converts string `_id` values into **MongoDB ObjectId** when needed.",
          "userId: mongo.objectId",
        ),
        annotations: {
          "expect.pattern": { pattern: "^[a-fA-F0-9]{24}$" },
        },
      },
    },
  },
};
