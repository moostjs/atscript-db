import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree, TMessages } from "@atscript/core";
import {
  validateExclusiveWith,
  validateFieldBaseType,
  validateSiblingStringField,
} from "../../shared/annotation-utils";

const CURRENCY_CODE_PATTERN = /^[A-Z0-9]{2,10}$/;

export const dbAmountAnnotations: TAnnotationsTree = {
  amount: {
    currency: {
      $self: new AnnotationSpec({
        description:
          "Hard-coded **currency code** for this amount field. Use when a table stores " +
          "amounts in a single, fixed currency.\n\n" +
          "For per-row currency, use `@db.amount.currency.ref 'fieldName'` instead.\n\n" +
          "Only valid on `decimal` fields — money in floating-point is wrong.\n\n" +
          "**Example:**\n" +
          "```atscript\n" +
          "@db.amount.currency 'EUR'\n" +
          "amount: decimal\n" +
          "```\n",
        nodeType: ["prop"],
        multiple: false,
        argument: {
          name: "code",
          type: "string",
          description:
            "Currency code — uppercase 2–10 alphanumerics (ISO 4217 or custom: 'EUR', 'USD', 'BTC').",
        },
        validate(token, args, doc) {
          const errors: TMessages = [];
          errors.push(...validateFieldBaseType(token, doc, "@db.amount.currency", "decimal"));
          errors.push(
            ...validateExclusiveWith(token, "@db.amount.currency", [
              { key: "db.amount.currency.ref", displayName: "@db.amount.currency.ref" },
            ]),
          );
          const code = args[0]?.text;
          if (code && !CURRENCY_CODE_PATTERN.test(code)) {
            errors.push({
              message: `@db.amount.currency '${code}': invalid currency code (expected 2–10 uppercase letters or digits)`,
              severity: 1,
              range: token.range,
            });
          }
          return errors;
        },
      }),
      ref: new AnnotationSpec({
        description:
          "Binds this amount to a **sibling field** that holds its currency code. " +
          "Use when each row may have a different currency.\n\n" +
          "The referenced field should be of type `db.currencyCode` (or at least a `string`).\n\n" +
          "Only valid on `decimal` fields.\n\n" +
          "**Example:**\n" +
          "```atscript\n" +
          "currency: db.currencyCode\n" +
          "@db.amount.currency.ref 'currency'\n" +
          "amount: decimal\n" +
          "```\n",
        nodeType: ["prop"],
        multiple: false,
        argument: {
          name: "fieldName",
          type: "string",
          description: "Name of the sibling property holding the currency code.",
        },
        validate(token, args, doc) {
          const errors: TMessages = [];
          errors.push(...validateFieldBaseType(token, doc, "@db.amount.currency.ref", "decimal"));
          // Cross-concept refs (currency-ref + unit-ref) on the same field would
          // collide in TableMetadata.quantityRefByField — reject up front.
          errors.push(
            ...validateExclusiveWith(token, "@db.amount.currency.ref", [
              { key: "db.amount.currency", displayName: "@db.amount.currency" },
              { key: "db.unit.ref", displayName: "@db.unit.ref" },
            ]),
          );
          errors.push(...validateSiblingStringField(token, args, doc, "@db.amount.currency.ref"));
          return errors;
        },
      }),
    },
  },
};
