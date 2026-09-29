import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree, TMessages } from "@atscript/core";
import { isRef } from "@atscript/core";

import { isDbSourceDecl, validateRefArgument } from "../../shared/validation-utils";
import { DB_ENTITY_ANNOTATIONS } from "../../shared/derived-rules";

/** The `accept` rule of a view-source ref argument (`@db.view.for`, `@db.alias`). */
export const VIEW_SOURCE_ARGUMENT = {
  accept: isDbSourceDecl,
  expected: "must be a @db.table or a @db.view.",
} as const;

/**
 * `@db.alias <Target>` — a named join scope over a table or view, so a view
 * can join the same table twice or join its own entry table (self-join).
 * @since 0.1.141
 */
export const dbAliasAnnotations: TAnnotationsTree = {
  alias: new AnnotationSpec({
    description:
      "Declares a **join alias**: a type alias of a `@db.table` or `@db.view` that a view can " +
      "join under its own name — to join the same table twice or to self-join the entry table. " +
      "Only valid on `export type X = Target`, where `Target` is the argument. The alias is a " +
      "scope name inside view definitions, not a table: it is never synced or registered on a " +
      "`DbSpace`, and it cannot be the `@db.view.for` entry.\n\n" +
      "**Example:**\n" +
      "```atscript\n" +
      "@db.alias Employee\n" +
      "export type Manager = Employee\n\n" +
      "@db.view.for Employee\n" +
      "@db.view.joins Manager, `Manager.id = Employee.managerId`, 'left'\n" +
      "export interface Staff {\n" +
      "    id: Employee.id\n" +
      "    managerName?: Manager.name\n" +
      "}\n" +
      "```\n",
    nodeType: ["type"],
    // A scope name describes the declaring alias only — a view field reading
    // `Manager.name` must not inherit it.
    passedWhenReferred: false,
    argument: {
      name: "target",
      type: "ref",
      description: "The aliased table or view type (must have @db.table or @db.view).",
      refFilter: isDbSourceDecl,
    },
    validate(token, args, doc) {
      const errors = [] as TMessages;
      const owner = token.parentNode!;
      const target = args[0]?.text;

      // VA3: an alias is a scope name, never a table or view of its own
      for (const name of DB_ENTITY_ANNOTATIONS) {
        if (owner.countAnnotations(name) > 0) {
          errors.push({
            message: `A @db.alias type cannot carry @${name} — it names a join scope over "${target ?? "…"}", not a table or view`,
            severity: 1,
            range: token.range,
          });
          break;
        }
      }

      if (!target) {
        return errors;
      }

      // VA1: `export type X = Target` — a plain reference to the argument
      const def = owner.getDefinition();
      const plainRef = def && isRef(def) && !def.hasChain ? def.id : undefined;
      if (plainRef !== target) {
        errors.push({
          message: `@db.alias ${target} must be declared on 'export type ${owner.id ?? "X"} = ${target}' — the type must be a plain reference to the aliased ${target}`,
          severity: 1,
          range: token.range,
        });
      }

      // VA2: the target is a table or a view, never another alias
      errors.push(...validateRefArgument(args[0], doc, VIEW_SOURCE_ARGUMENT));

      return errors;
    },
  }),
};
