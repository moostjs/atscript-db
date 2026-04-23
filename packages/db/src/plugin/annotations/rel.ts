import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";
import {
  isArray,
  isInterface,
  isPrimitive,
  isRef,
  isStructure,
  type SemanticRefNode,
  type SemanticStructureNode,
} from "@atscript/core";
import type { TMessages } from "@atscript/core";
import {
  getAnnotationAlias,
  getDbTableOwner,
  getNavTargetTypeName,
  getParentStruct,
  getParentTypeName,
  refActionAnnotation,
} from "../../shared/annotation-utils";
import {
  findFKFieldsPointingTo,
  validateQueryScope,
  validateRefArgument,
} from "../../shared/validation-utils";

export const dbRelAnnotations: TAnnotationsTree = {
  rel: {
    FK: new AnnotationSpec({
      description:
        "Declares a foreign key reference on this field. The field must use a chain " +
        "reference type (e.g., `User.id`) whose target is a primary key (`@meta.id`) " +
        "or unique (`@db.index.unique`) field.\n\n" +
        "**Dual role:**\n" +
        "- On a `@db.table` interface, `@db.rel.FK` additionally drives DB-relation semantics — " +
        "  relation loading with `@db.rel.to` / `@db.rel.from`, junction pairing with `@db.rel.via`, etc.\n" +
        "- On any other interface (value-help sources, WF forms, plain interfaces), `@db.rel.FK` " +
        "  acts purely as the value-help indicator: the client-side picker resolver uses it to " +
        "  decide which fields render a value-help picker. The target's `@db.http.path` (stamped " +
        "  by its readable controller) supplies the picker URL.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.rel.FK\n" +
        "authorId: User.id\n" +
        "\n" +
        "// With alias (required when multiple FKs point to the same type)\n" +
        '@db.rel.FK "author"\n' +
        "authorId: User.id\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        optional: true,
        name: "alias",
        type: "string",
        description:
          "Alias for pairing with @db.rel.to. Required when multiple FKs point to the same target type.",
      },
      validate(token, args, doc) {
        const errors = [] as TMessages;
        const field = token.parentNode!;
        const alias = args[0]?.text;

        // F1 (relaxed): `@db.rel.FK` validates on any interface kind — @db.table hosts get the
        // full DB-relation semantics, other hosts use it purely as the value-help indicator.

        // F6: Cannot coexist with @db.rel.to or @db.rel.from
        if (field.countAnnotations("db.rel.to") > 0 || field.countAnnotations("db.rel.from") > 0) {
          errors.push({
            message: "A field cannot be both a foreign key and a navigational property",
            severity: 1,
            range: token.range,
          });
        }

        // F2: Field type must be a chain reference
        const definition = field.getDefinition();
        if (!definition || !isRef(definition) || !(definition as SemanticRefNode).hasChain) {
          errors.push({
            message: `@db.rel.FK requires a chain reference type (e.g. User.id), got scalar type`,
            severity: 1,
            range: token.range,
          });
          return errors;
        }

        const ref = definition as SemanticRefNode;
        const refTypeName = ref.id!;
        const chainFields = ref.chain.map((c) => c.text);

        // X2: FK target field must be @meta.id or @db.index.unique
        // F3: FK must resolve to a scalar type
        const targetUnwound = doc.unwindType(refTypeName);
        if (targetUnwound) {
          const targetDef = targetUnwound.def;
          if (isInterface(targetDef) || isStructure(targetDef)) {
            const struct = isInterface(targetDef)
              ? (targetDef.getDefinition() as SemanticStructureNode | undefined)
              : targetDef;
            if (struct && isStructure(struct) && chainFields.length > 0) {
              const targetProp = struct.props.get(chainFields[0]);
              if (targetProp) {
                // X2: Check that target field is @meta.id or @db.index.unique
                if (
                  targetProp.countAnnotations("meta.id") === 0 &&
                  targetProp.countAnnotations("db.index.unique") === 0
                ) {
                  errors.push({
                    message: `@db.rel.FK target '${refTypeName}.${chainFields.join(".")}' is not a primary key (@meta.id) or unique (@db.index.unique) field`,
                    severity: 1,
                    range: token.range,
                  });
                }

                // F3: Check that FK resolves to a scalar type
                const propDef = targetProp.getDefinition();
                if (propDef && isRef(propDef)) {
                  const propUnwound = targetUnwound.doc.unwindType(propDef.id!, propDef.chain);
                  if (propUnwound && !isPrimitive(propUnwound.def)) {
                    errors.push({
                      message: `Foreign key field must resolve to a scalar type (number, string, etc.), got '${propDef.id}'`,
                      severity: 1,
                      range: token.range,
                    });
                  }
                } else if (propDef && !isPrimitive(propDef)) {
                  errors.push({
                    message: `Foreign key field must resolve to a scalar type (number, string, etc.)`,
                    severity: 1,
                    range: token.range,
                  });
                }
              }
            }
          }
        }

        // F4: Multiple unaliased FKs to same target type
        if (!alias) {
          const struct = getParentStruct(token);
          if (struct) {
            let sameTargetCount = 0;
            for (const [, prop] of struct.props) {
              if (prop.countAnnotations("db.rel.FK") === 0) {
                continue;
              }
              const def = prop.getDefinition();
              if (!def || !isRef(def)) {
                continue;
              }
              const r = def as SemanticRefNode;
              if (!r.hasChain) {
                continue;
              }
              if (r.id === refTypeName) {
                if (!getAnnotationAlias(prop, "db.rel.FK")) {
                  sameTargetCount++;
                }
              }
            }
            if (sameTargetCount > 1) {
              errors.push({
                message: `Multiple @db.rel.FK fields resolve to type '${refTypeName}' — add alias to disambiguate`,
                severity: 1,
                range: token.range,
              });
            }
          }
        }

        return errors;
      },
    }),

    to: new AnnotationSpec({
      description:
        "Forward navigational property — the FK is on **this** interface. " +
        "The compiler resolves the matching @db.rel.FK by target type or alias.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.rel.to\n" +
        "author?: User\n" +
        "\n" +
        "// With alias\n" +
        '@db.rel.to "author"\n' +
        "author?: User\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        optional: true,
        name: "alias",
        type: "string",
        description: "Match a local @db.rel.FK by alias.",
      },
      validate(token, args, doc) {
        const errors = [] as TMessages;
        const field = token.parentNode!;
        const alias = args[0]?.text;

        // T2: Must be on a @db.table interface
        const owner = getDbTableOwner(token);
        if (!owner || owner.countAnnotations("db.table") === 0) {
          errors.push({
            message: "@db.rel.to is only valid on fields of a @db.table interface",
            severity: 1,
            range: token.range,
          });
        }

        // F6: Cannot coexist with @db.rel.FK
        if (field.countAnnotations("db.rel.FK") > 0) {
          errors.push({
            message: "A field cannot be both a foreign key and a navigational property",
            severity: 1,
            range: token.range,
          });
        }

        const targetTypeName = getNavTargetTypeName(field);
        if (!targetTypeName) {
          return errors;
        }

        // T1: Target type must have @db.table
        const unwound = doc.unwindType(targetTypeName);
        if (unwound) {
          const targetDef = unwound.def;
          const targetNode = isInterface(targetDef) ? targetDef : undefined;
          if (!targetNode || targetNode.countAnnotations("db.table") === 0) {
            errors.push({
              message: `@db.rel.to target '${targetTypeName}' is not a @db.table entity`,
              severity: 1,
              range: token.range,
            });
          }
        }

        // T7: .to type must not be a union type
        const fieldDef = field.getDefinition();
        if (fieldDef && fieldDef.entity === "group" && (fieldDef as any).op === "|") {
          errors.push({
            message: "@db.rel.to does not support union types — use separate relations",
            severity: 1,
            range: token.range,
          });
        }

        // T3/T4/T5/T6: Find matching FK on this interface
        const struct = getParentStruct(token);
        if (struct) {
          // T6: Duplicate .to with same alias/target
          const fieldName = field.id;
          for (const [name, prop] of struct.props) {
            if (name === fieldName) {
              continue;
            }
            if (prop.countAnnotations("db.rel.to") === 0) {
              continue;
            }
            const propAlias = getAnnotationAlias(prop, "db.rel.to");
            if ((alias || undefined) === (propAlias || undefined)) {
              const otherTarget = getNavTargetTypeName(prop);
              if (otherTarget === targetTypeName) {
                errors.push({
                  message: `Duplicate @db.rel.to '${alias || targetTypeName}' — only one forward navigational property per alias`,
                  severity: 1,
                  range: token.range,
                });
                break;
              }
            }
          }

          if (alias) {
            // T5: Aliased — must find FK with matching alias
            const matches = findFKFieldsPointingTo(doc, struct, targetTypeName, alias);
            if (matches.length === 0) {
              errors.push({
                message: `No @db.rel.FK '${alias}' found on this interface`,
                severity: 1,
                range: token.range,
              });
            }
          } else {
            // T3/T4: Unaliased — find single FK pointing to target type
            const matches = findFKFieldsPointingTo(doc, struct, targetTypeName);
            if (matches.length === 0) {
              errors.push({
                message: `No @db.rel.FK on this interface points to '${targetTypeName}' — did you mean @db.rel.from?`,
                severity: 1,
                range: token.range,
              });
            } else if (matches.length > 1) {
              errors.push({
                message: `Multiple @db.rel.FK fields point to '${targetTypeName}' — add alias to disambiguate`,
                severity: 1,
                range: token.range,
              });
            }
          }
        }

        return errors;
      },
    }),

    from: new AnnotationSpec({
      description:
        "Inverse navigational property — the FK is on the **target** interface, pointing back to this one.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.rel.from\n" +
        "posts: Post[]\n" +
        "\n" +
        "// With alias\n" +
        '@db.rel.from "original"\n' +
        "comments: Comment[]\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        optional: true,
        name: "alias",
        type: "string",
        description: "Match a @db.rel.FK on the target interface by alias.",
      },
      validate(token, args, doc) {
        const errors = [] as TMessages;
        const field = token.parentNode!;
        const alias = args[0]?.text;

        // R2: Must be on a @db.table interface
        const owner = getDbTableOwner(token);
        if (!owner || owner.countAnnotations("db.table") === 0) {
          errors.push({
            message: "@db.rel.from is only valid on fields of a @db.table interface",
            severity: 1,
            range: token.range,
          });
        }

        // F6: Cannot coexist with @db.rel.FK
        if (field.countAnnotations("db.rel.FK") > 0) {
          errors.push({
            message: "A field cannot be both a foreign key and a navigational property",
            severity: 1,
            range: token.range,
          });
        }

        const targetTypeName = getNavTargetTypeName(field);
        if (!targetTypeName) {
          return errors;
        }

        // R1: Target type must have @db.table
        const unwound = doc.unwindType(targetTypeName);
        if (!unwound) {
          return errors;
        }
        const targetDef = unwound.def;
        const targetDoc = unwound.doc;
        if (!isInterface(targetDef) || targetDef.countAnnotations("db.table") === 0) {
          errors.push({
            message: `@db.rel.from target '${targetTypeName}' is not a @db.table entity`,
            severity: 1,
            range: token.range,
          });
          return errors;
        }

        // R6: Duplicate .from with same alias/target
        const struct = getParentStruct(token);
        if (struct) {
          const fieldName = field.id;
          for (const [name, prop] of struct.props) {
            if (name === fieldName) {
              continue;
            }
            if (prop.countAnnotations("db.rel.from") === 0) {
              continue;
            }
            const propAlias = getAnnotationAlias(prop, "db.rel.from");
            if ((alias || undefined) === (propAlias || undefined)) {
              const otherTarget = getNavTargetTypeName(prop);
              if (otherTarget === targetTypeName) {
                errors.push({
                  message: `Duplicate @db.rel.from '${alias || targetTypeName}' — only one inverse navigational property per alias`,
                  severity: 1,
                  range: token.range,
                });
                break;
              }
            }
          }
        }

        // R3/R4/R5: Find matching FK on the target type pointing back to this type
        const thisTypeName = getParentTypeName(token);
        if (!thisTypeName) {
          return errors;
        }

        const matches = findFKFieldsPointingTo(targetDoc, targetDef, thisTypeName, alias);
        if (alias) {
          // R5: Aliased — must find FK with matching alias on target
          if (matches.length === 0) {
            errors.push({
              message: `No @db.rel.FK '${alias}' found on '${targetTypeName}'`,
              severity: 1,
              range: token.range,
            });
          }
        } else {
          // R3/R4: Unaliased — find single FK on target pointing back
          if (matches.length === 0) {
            errors.push({
              message: `No @db.rel.FK on '${targetTypeName}' points to '${thisTypeName}'`,
              severity: 1,
              range: token.range,
            });
          } else if (matches.length > 1) {
            errors.push({
              message: `'${targetTypeName}' has multiple @db.rel.FK fields pointing to '${thisTypeName}' — add alias`,
              severity: 1,
              range: token.range,
            });
          }
        }

        // R7: Singular (non-array) from but FK on target not unique
        const fieldDef = field.getDefinition();
        if (!isArray(fieldDef) && matches.length === 1) {
          const fkProp = matches[0].prop;
          if (fkProp.countAnnotations("db.index.unique") === 0) {
            errors.push({
              message: `@db.rel.from '${field.id}' has singular type '${targetTypeName}' (1:1) but the FK on '${targetTypeName}' is not @db.index.unique — did you mean '${targetTypeName}[]' (1:N)?`,
              severity: 2,
              range: token.range,
            });
          }
        }

        return errors;
      },
    }),

    onDelete: refActionAnnotation("onDelete"),
    onUpdate: refActionAnnotation("onUpdate"),

    via: new AnnotationSpec({
      description:
        "Declares a many-to-many navigational property through an explicit junction table. " +
        "`@db.rel.via` is self-sufficient — no `@db.rel.from` pairing is needed.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.rel.via PostTag\n" +
        "tags: Tag[]\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        name: "junction",
        type: "ref",
        description:
          "The junction table type (must have @db.table and @db.rel.FK fields pointing to both sides).",
      },
      validate(token, args, doc) {
        const errors = [] as TMessages;
        const field = token.parentNode!;

        // V6: Cannot coexist with .to or .from
        if (field.countAnnotations("db.rel.to") > 0 || field.countAnnotations("db.rel.from") > 0) {
          errors.push({
            message:
              "@db.rel.via is self-sufficient — cannot be combined with @db.rel.to or @db.rel.from",
            severity: 1,
            range: token.range,
          });
        }

        // V1: Must be on an array field
        const definition = field.getDefinition();
        if (!isArray(definition)) {
          errors.push({
            message: "@db.rel.via requires an array type (e.g. Tag[])",
            severity: 1,
            range: token.range,
          });
        }

        if (!args[0]) {
          return errors;
        }

        const junctionName = args[0].text;

        // V2: Junction type must have @db.table (via validateRefArgument)
        errors.push(...validateRefArgument(args[0], doc, { requireDbTable: true }));
        if (errors.length > 0) {
          return errors;
        }

        // Resolve junction type for FK checks
        const junctionUnwound = doc.unwindType(junctionName);
        if (!junctionUnwound) {
          return errors;
        }
        const junctionDef = junctionUnwound.def;
        if (!isInterface(junctionDef)) {
          return errors;
        }

        // Get this type name and target type name
        const thisTypeName = getParentTypeName(token);
        const targetTypeName = getNavTargetTypeName(field);
        if (!thisTypeName || !targetTypeName) {
          return errors;
        }

        // V3: Junction must have FK pointing to this type
        const fksToThis = findFKFieldsPointingTo(junctionUnwound.doc, junctionDef, thisTypeName);
        if (fksToThis.length === 0) {
          errors.push({
            message: `Junction '${junctionName}' has no @db.rel.FK pointing to '${thisTypeName}'`,
            severity: 1,
            range: args[0].range,
          });
        } else if (fksToThis.length > 1) {
          // V5: Multiple FKs to same type
          errors.push({
            message: `Junction '${junctionName}' has multiple @db.rel.FK pointing to '${thisTypeName}' — not supported`,
            severity: 1,
            range: args[0].range,
          });
        }

        // V4: Junction must have FK pointing to target type
        // (skip if this === target, e.g. self-referencing M:N — the same FKs serve both)
        if (targetTypeName !== thisTypeName) {
          const fksToTarget = findFKFieldsPointingTo(
            junctionUnwound.doc,
            junctionDef,
            targetTypeName,
          );
          if (fksToTarget.length === 0) {
            errors.push({
              message: `Junction '${junctionName}' has no @db.rel.FK pointing to '${targetTypeName}'`,
              severity: 1,
              range: args[0].range,
            });
          } else if (fksToTarget.length > 1) {
            // V5: Multiple FKs to same type
            errors.push({
              message: `Junction '${junctionName}' has multiple @db.rel.FK pointing to '${targetTypeName}' — not supported`,
              severity: 1,
              range: args[0].range,
            });
          }
        }

        return errors;
      },
    }),

    filter: new AnnotationSpec({
      description:
        "Applies a filter to a navigational property, restricting which related records are loaded.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.rel.from\n" +
        "@db.rel.filter `Post.published = true`\n" +
        "publishedPosts: Post[]\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        name: "condition",
        type: "query",
        description: "Filter expression restricting which related records are loaded.",
      },
      validate(token, args, doc) {
        const errors = [] as TMessages;
        const field = token.parentNode!;

        const hasTo = field.countAnnotations("db.rel.to") > 0;
        const hasFrom = field.countAnnotations("db.rel.from") > 0;
        const hasVia = field.countAnnotations("db.rel.via") > 0;

        // FL1: Must be on a navigational field
        if (!hasTo && !hasFrom && !hasVia) {
          errors.push({
            message:
              "@db.rel.filter is only valid on navigational fields (@db.rel.to, @db.rel.from, or @db.rel.via)",
            severity: 1,
            range: token.range,
          });
          return errors;
        }

        if (!args[0]?.queryNode) {
          return errors;
        }

        // Determine scope based on nav type
        const targetTypeName = getNavTargetTypeName(field);
        if (!targetTypeName) {
          return errors;
        }

        const allowedTypes: string[] = [targetTypeName];
        if (hasVia) {
          const junctionType = getAnnotationAlias(field, "db.rel.via");
          if (junctionType) {
            allowedTypes.push(junctionType);
          }
        }

        // FL2/FL3: Validate query scope
        errors.push(...validateQueryScope(args[0], allowedTypes, targetTypeName, doc));

        return errors;
      },
    }),
  },
};
