import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";
import { validateFieldBaseType } from "../../shared/annotation-utils";

export const dbAggAnnotations: TAnnotationsTree = {
  agg: {
    sum: new AnnotationSpec({
      description: "Declares a view field as SUM of a source column.",
      nodeType: ["prop"],
      argument: { name: "field", type: "string", description: "Source column name to sum." },
      validate(token, _args, doc) {
        return validateFieldBaseType(token, doc, "@db.agg.sum", ["number", "decimal"]);
      },
    }),
    avg: new AnnotationSpec({
      description: "Declares a view field as AVG of a source column.",
      nodeType: ["prop"],
      argument: { name: "field", type: "string", description: "Source column name to average." },
      validate(token, _args, doc) {
        return validateFieldBaseType(token, doc, "@db.agg.avg", ["number", "decimal"]);
      },
    }),
    count: new AnnotationSpec({
      description:
        "Declares a view field as COUNT. Without argument: COUNT(*). " +
        "With field name argument: COUNT(field) (non-null count).",
      nodeType: ["prop"],
      argument: {
        name: "field",
        type: "string",
        optional: true,
        description: "Source column name to count non-null values. Omit for COUNT(*).",
      },
      validate(token, _args, doc) {
        return validateFieldBaseType(token, doc, "@db.agg.count", ["number"]);
      },
    }),
    min: new AnnotationSpec({
      description: "Declares a view field as MIN of a source column.",
      nodeType: ["prop"],
      argument: { name: "field", type: "string", description: "Source column name." },
    }),
    max: new AnnotationSpec({
      description: "Declares a view field as MAX of a source column.",
      nodeType: ["prop"],
      argument: { name: "field", type: "string", description: "Source column name." },
    }),
  },
};
