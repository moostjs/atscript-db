import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree, TMessages } from "@atscript/core";
import {
  validateExclusiveWith,
  validateFieldBaseType,
  validateSiblingStringField,
} from "../../shared/annotation-utils";

const UNIT_HOST_TYPES = ["decimal", "number"];

export const dbUnitAnnotations: TAnnotationsTree = {
  unit: {
    $self: new AnnotationSpec({
      description:
        "Hard-coded **unit of measure** for this quantity field. Use when a table " +
        "stores all values for this field in a single, fixed unit.\n\n" +
        "For per-row units, use `@db.unit.ref 'fieldName'` instead.\n\n" +
        "Valid on `decimal` and `number` fields. Unlike `@db.amount.currency`, the " +
        "unit code is free-form (`'kg'`, `'rpm'`, `'qps'`, …) — no ISO-style validation.\n\n" +
        "Aggregations on a unit-tagged field do not need grouping when the unit is a " +
        "fixed literal — the constraint is satisfied schema-wide.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.unit 'kg'\n" +
        "weight: decimal\n" +
        "```\n",
      nodeType: ["prop"],
      multiple: false,
      argument: {
        name: "code",
        type: "string",
        description: "Unit code (free-form: 'kg', 'g', 'lb', 'm', 'rpm', 'qps', etc.).",
      },
      validate(token, _args, doc) {
        const errors: TMessages = [];
        errors.push(...validateFieldBaseType(token, doc, "@db.unit", UNIT_HOST_TYPES));
        errors.push(
          ...validateExclusiveWith(token, "@db.unit", [
            { key: "db.unit.ref", displayName: "@db.unit.ref" },
          ]),
        );
        return errors;
      },
    }),
    ref: new AnnotationSpec({
      description:
        "Binds this quantity to a **sibling field** that holds its unit. Use when " +
        "different rows may carry different units (e.g. mixed kg/lb measurements).\n\n" +
        "The referenced field must be a `string`.\n\n" +
        "Valid on `decimal` and `number` fields. Aggregating this field forces the " +
        "referenced unit field into `$groupBy` at runtime — summing rows with " +
        "different units is rejected.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "unit: string\n" +
        "@db.unit.ref 'unit'\n" +
        "weight: decimal\n" +
        "```\n",
      nodeType: ["prop"],
      multiple: false,
      argument: {
        name: "fieldName",
        type: "string",
        description: "Name of the sibling property holding the unit code.",
      },
      validate(token, args, doc) {
        const errors: TMessages = [];
        errors.push(...validateFieldBaseType(token, doc, "@db.unit.ref", UNIT_HOST_TYPES));
        errors.push(
          ...validateExclusiveWith(token, "@db.unit.ref", [
            { key: "db.unit", displayName: "@db.unit" },
            { key: "db.amount.currency.ref", displayName: "@db.amount.currency.ref" },
          ]),
        );
        errors.push(...validateSiblingStringField(token, args, doc, "@db.unit.ref"));
        return errors;
      },
    }),
  },
};
