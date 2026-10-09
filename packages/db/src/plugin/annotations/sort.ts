import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree, TMessages } from "@atscript/core";
import { isArray, isInterface, isPrimitive, isRef, isStructure } from "@atscript/core";

import { getDbTableOwner, primitiveBaseType } from "../../shared/annotation-utils";

/**
 * `@db.sort.nulls` (since 0.1.153) — a field's default NULL placement when a
 * read sorts by it without a `$nulls` entry for it.
 */
export const dbSortAnnotations: TAnnotationsTree = {
  sort: {
    nulls: new AnnotationSpec({
      description:
        "Default **NULL placement** when a read sorts by this field and the request names none " +
        "(`$nulls` control, URL suffix `$sort=-closedAt:last`).\n\n" +
        "- **`'first'`** — rows where the field is NULL (or missing) come before every value, " +
        "in both sort directions\n" +
        "- **`'last'`** — they come after every value, in both directions\n\n" +
        "Without it (and without `$nulls`) NULL placement is the database's own: first in " +
        "ascending order on SQLite, MySQL, MongoDB and the in-memory adapter, last on PostgreSQL. " +
        "Applies to `$sort` and to the `$rowOrder` of `first()` / `last()`. Only optional fields " +
        "can be NULL — on a required table field it has no effect. On PostgreSQL, MySQL and " +
        "MongoDB a placement the engine does not produce natively costs the index its ORDER BY " +
        "(a sort step instead).\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.sort.nulls 'last'\n" +
        "closedAt?: number.timestamp\n" +
        "```\n",
      nodeType: ["prop"],
      passedWhenReferred: false,
      multiple: false,
      argument: {
        name: "placement",
        type: "string",
        values: ["first", "last"],
        description:
          "Where NULL goes: 'first' (before every value) or 'last' (after every value), " +
          "whatever the sort direction.",
      },
      validate(token, _args, doc) {
        const errors = [] as TMessages;
        const field = token.parentNode!;
        const fail = (message: string, severity: 1 | 2 = 1) =>
          errors.push({ message, severity, range: token.range });

        if (field.countAnnotations("db.json") > 0) {
          fail("@db.sort.nulls on a @db.json field — JSON-stored fields are not sortable");
          return errors;
        }
        if (field.countAnnotations("db.encrypted") > 0) {
          fail("@db.sort.nulls on a @db.encrypted field — encrypted fields are not sortable");
          return errors;
        }
        const def = field.getDefinition();
        let leaf = def;
        if (def && isRef(def)) leaf = doc.unwindType(def.id!, def.chain)?.def;
        const base = primitiveBaseType(leaf);
        if (
          (def && (isArray(def) || isStructure(def))) ||
          (leaf && (isArray(leaf) || isStructure(leaf) || isInterface(leaf))) ||
          (leaf && isPrimitive(leaf) && (base === "array" || base === "object"))
        ) {
          fail("@db.sort.nulls needs a sortable scalar field — not an object or an array");
          return errors;
        }
        // A required top-level field of a table is NOT NULL: nothing to place.
        // (A view column can be NULL through a left join or an aggregate, and a
        // nested field through its optional parent, so neither is flagged.)
        const owner = getDbTableOwner(token);
        if (
          !field.has("optional") &&
          owner &&
          owner.countAnnotations("db.table") > 0 &&
          field.ownerNode?.ownerNode === owner
        ) {
          fail(
            "@db.sort.nulls on a required field has no effect — the field is never NULL; " +
              "make it optional (field?: …) or remove the annotation",
            2,
          );
        }
        return errors;
      },
    }),
  },
};
