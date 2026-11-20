// oxlint-disable max-lines
// oxlint-disable max-depth
import type {
  TAtscriptAnnotatedType,
  TAtscriptTypeArray,
  TAtscriptTypeObject,
  TValidatorOptions,
  Validator,
} from "@atscript/typescript/utils";
import { getKeyProps, getDbFieldOp, isPlainObject } from "@atscript/db";
import type { TFieldOps } from "@atscript/db";
import { type Document, type Filter, type UpdateFilter, type UpdateOptions } from "mongodb";
import { joinPath } from "./path-utils";

/**
 * `items` of an array operator as an aggregation operand. Always a
 * `$literal`: the items are data, and an aggregation expression would read a
 * `$`-prefixed string in them as a field path — storing another field's
 * value, a secret one included, where the string was sent (since 0.1.180).
 */
const literal = (items: unknown[]): Document => ({ $literal: items });

/**
 * True when a user value contains a `$`-prefixed string or object key — the
 * shapes aggregation `$set` would evaluate as field paths / operators instead
 * of treating as literal data. Caller must wrap such values in `{ $literal }`.
 */
function containsAggregationExpr(v: unknown): boolean {
  if (typeof v === "string") return v.startsWith("$");
  if (Array.isArray(v)) return v.some(containsAggregationExpr);
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (k.startsWith("$")) return true;
      if (containsAggregationExpr((v as Record<string, unknown>)[k])) return true;
    }
  }
  return false;
}

/**
 * Context interface for CollectionPatcher.
 * Decouples the patcher from AsCollection, allowing MongoAdapter to provide this.
 */
export interface TCollectionPatcherContext {
  flatMap: Map<string, TAtscriptAnnotatedType>;
  prepareId(id: any): any;
  createValidator(opts?: Partial<TValidatorOptions>): Validator<any>;
}

/**
 * A field's current value in an aggregation pipeline update — a missing field
 * counts as `0`, like the `$inc` / `$mul` update operators (the pipeline
 * `$add` / `$multiply` would yield `null`) — so a document written before an
 * `@db.onUpdate.inc` counter existed starts counting.
 */
function fieldOpCurrent(field: string): Document {
  return { $ifNull: [`$${field}`, 0] };
}

/** Aggregation expression adding `by` to `field` (an `$inc` in a pipeline update). */
export function incExpr(field: string, by: number): Document {
  return { $add: [fieldOpCurrent(field), by] };
}

/**
 * CollectionPatcher is a small helper that converts a *patch payload* produced
 * by Atscript into a shape that the official MongoDB driver understands – a
 * triple of `(filter, update, options)` to be fed to `collection.updateOne()`.
 *
 * Supported high‑level operations for *top‑level arrays* (see the attached
 * spreadsheet in the chat):
 *
 * | Payload field | Pipeline expression        | Purpose                                              |
 * |---------------|----------------------------|------------------------------------------------------|
 * | `$replace`    | `$literal`                 | Replace the whole array (stands alone).              |
 * | `$insert`     | `$concatArrays`, `$reduce` | Append; a stored key / unique value is skipped.      |
 * | `$upsert`     | `$reduce` + `$map`         | Change the element of a *key* in place, or append.   |
 * | `$update`     | `$reduce` + `$map`         | Change the elements matched by *key*.                |
 * | `$remove`     | `$filter`                  | Remove by value or by *key*.                         |
 *
 * The result is the array the read-modify-write of the other adapters gives
 * (`resolveArrayOps` in `@atscript/db`).
 *
 * The class walks through the incoming payload, detects which of the above
 * operations applies to each top‑level array and builds the corresponding
 * MongoDB update document. Primitive fields are flattened into a regular
 * `$set` map.
 */
export class CollectionPatcher {
  constructor(
    private collection: TCollectionPatcherContext,
    private payload: any,
    private ops?: TFieldOps,
  ) {}

  static getKeyProps = getKeyProps;

  /**
   * Internal accumulator: filter passed to `updateOne()`.
   * Filled only with the `_id` field right now.
   */
  private filterObj = {} as Filter<any>;

  /** MongoDB *update* document being built. */
  private updatePipeline = [] as Document[];

  /** Current `$set` stage being populated. */
  private currentSetStage: Document | null = null;

  /** Additional *options* (mainly `arrayFilters`). */
  private optionsObj = {} as UpdateOptions;

  /**
   * Entry point – walk the payload, build `filter`, `update` and `options`.
   *
   * @returns Helper object exposing both individual parts and
   *          a `.toArgs()` convenience callback.
   */
  public preparePatch() {
    this.filterObj = {
      _id: this.collection.prepareId(this.payload._id),
    };
    this.flattenPayload(this.payload);
    // Apply pre-separated field ops as aggregation expressions
    if (this.ops?.inc) {
      for (const key in this.ops.inc) {
        this._set(key, this._fieldOpExpr(key, "inc", this.ops.inc[key]!));
      }
    }
    if (this.ops?.mul) {
      for (const key in this.ops.mul) {
        this._set(key, this._fieldOpExpr(key, "mul", this.ops.mul[key]!));
      }
    }
    const updateFilter = this.updatePipeline;
    return {
      toArgs: (): [Filter<any>, UpdateFilter<any> | Document[], UpdateOptions] => [
        this.filterObj,
        updateFilter,
        this.optionsObj,
      ],
      filter: this.filterObj,
      updateFilter: updateFilter,
      updateOptions: this.optionsObj,
    };
  }

  // ---------------------------------------------------------------------------
  //  Internals
  // ---------------------------------------------------------------------------

  /** Aggregation expression of an `$inc` / `$mul` field op (see {@link fieldOpCurrent}). */
  private _fieldOpExpr(key: string, op: "inc" | "mul", value: number): Document {
    return op === "inc" ? incExpr(key, value) : { $multiply: [fieldOpCurrent(key), value] };
  }

  /**
   * Helper – lazily create `$set` section and assign *key* → *value*.
   *
   * @param key Fully‑qualified dotted path
   * @param val Value to be written
   * @private
   */
  private _set(key: string, val: any) {
    if (this.currentSetStage && !(key in this.currentSetStage.$set)) {
      this.currentSetStage.$set[key] = val;
      return;
    }
    // Key collision or no current stage — start a new $set stage
    this.currentSetStage = { $set: { [key]: val } };
    this.updatePipeline.push(this.currentSetStage);
  }

  /**
   * Set a leaf, lifting an `$inc`/`$mul` field op into an aggregation expression if present.
   * `type`: the field's type, when known.
   */
  private _setLeaf(key: string, value: unknown, type?: TAtscriptAnnotatedType) {
    const fieldOp = getDbFieldOp(value);
    if (fieldOp) {
      this._set(key, this._fieldOpExpr(key, fieldOp.op, fieldOp.value));
    } else if (containsAggregationExpr(value) || replacesWhole(value, type)) {
      // Aggregation `$set` would read `$`-prefixed strings as field paths and
      // drop the target when the path is missing (e.g. password hashes), and
      // MERGES an object into the stored one.
      this._set(key, { $literal: value });
    } else {
      this._set(key, value);
    }
  }

  /**
   * Recursively walk through the patch *payload* and convert it into `$set`/…
   * statements. Top‑level arrays are delegated to {@link parseArrayPatch}.
   *
   * @param payload Current payload chunk
   * @param prefix  Dotted path accumulated so far
   * @private
   */
  private flattenPayload(payload: any, prefix = ""): UpdateFilter<any> {
    const evalKey = (k: string) => joinPath(prefix, k);
    for (const [_key, value] of Object.entries(payload)) {
      const key = evalKey(_key);
      const flatType = this.collection.flatMap.get(key);
      const topLevelArray = flatType?.metadata?.get("db.__topLevelArray") as boolean | undefined;
      const isObjectValue = typeof value === "object" && value !== null && !Array.isArray(value);
      if (isObjectValue && topLevelArray && !flatType?.metadata?.has("db.json")) {
        this.parseArrayPatch(key, value, flatType!);
      } else if (isObjectValue && flatType?.metadata?.get("db.patch.strategy") === "merge") {
        this.flattenPayload(value, key);
      } else if (
        isObjectValue &&
        flatType?.type.kind === "object" &&
        !flatType.metadata?.has("db.json")
      ) {
        this._flattenReplaceObject(value as Record<string, unknown>, key, flatType);
      } else if (key !== "_id") {
        this._setLeaf(key, value, flatType);
      }
    }
    return this.updatePipeline;
  }

  /**
   * Walk the schema's props for a replace-strategy nested object so omitted
   * optional children become explicit nulls (parity with SQL `column = NULL`).
   * Required-missing leaves are caught earlier by the strict validator.
   */
  private _flattenReplaceObject(
    value: Record<string, unknown>,
    prefix: string,
    flatType: TAtscriptAnnotatedType,
  ): void {
    const propsMap = (flatType.type as TAtscriptTypeObject).props;
    for (const [propKey, propType] of propsMap) {
      const childKey = `${prefix}.${propKey}`;
      const childValue = value[propKey];
      if (childValue === undefined) {
        if (propType.optional === true) this._set(childKey, null);
        continue;
      }
      const childIsObject =
        typeof childValue === "object" && childValue !== null && !Array.isArray(childValue);
      const propIsJson = propType.metadata?.has("db.json");
      const propIsMerge = propType.metadata?.get("db.patch.strategy") === "merge";
      // An array operator on an array of this object (since 0.1.180; before,
      // the operator object itself was stored as the field's value)
      const childFlatType = this.collection.flatMap.get(childKey);
      if (childIsObject && !propIsJson && childFlatType?.metadata?.get("db.__topLevelArray")) {
        this.parseArrayPatch(childKey, childValue, childFlatType);
        continue;
      }
      if (childIsObject && propType.type.kind === "object" && !propIsJson) {
        if (propIsMerge) {
          this.flattenPayload(childValue, childKey);
        } else {
          this._flattenReplaceObject(childValue as Record<string, unknown>, childKey, propType);
        }
        continue;
      }
      this._setLeaf(childKey, childValue, propType);
    }
  }

  /**
   * Dispatch a *single* array patch. Exactly one of `$replace`, `$insert`,
   * `$upsert`, `$update`, `$remove` must be present – otherwise we throw.
   *
   * @param key   Dotted path to the array field
   * @param value Payload slice for that field
   * @private
   */
  private parseArrayPatch(key: string, value: any, flatType: TAtscriptAnnotatedType) {
    const toRemove = value.$remove as any[] | undefined;
    const toReplace = value.$replace as any[] | undefined;
    const toInsert = value.$insert as any[] | undefined;
    const toUpsert = value.$upsert as any[] | undefined;
    const toUpdate = value.$update as any[] | undefined;

    const keyProps =
      flatType.type.kind === "array"
        ? getKeyProps(flatType as TAtscriptAnnotatedType<TAtscriptTypeArray>)
        : new Set<string>();
    const keys = keyProps.size > 0 ? [...keyProps] : [];

    // `$replace` stands alone, as on the other adapters (since 0.1.180; before,
    // the other operators were applied to the new array)
    if (toReplace !== undefined) {
      this._replace(key, toReplace);
      return;
    }
    // The documented order, as the read-modify-write of the other adapters
    // applies them: remove → update → upsert → insert (since 0.1.180; before,
    // insert → upsert → update)
    this._remove(key, toRemove, keys, flatType);
    this._update(key, toUpdate, keys, flatType);
    this._upsert(key, toUpsert, keys, flatType);
    this._insert(key, toInsert, keys, flatType);
  }

  /**
   * Build an *aggregation‐expression* that checks equality by **all** keys in
   * `keys`.  Example output for keys `["id", "lang"]` and bases `a`, `b`:
   * ```json
   * { "$and": [ { "$eq": ["$$a.id", "$$b.id"] }, { "$eq": ["$$a.lang", "$$b.lang"] } ] }
   * ```
   *
   * @param keys  Ordered list of key property names
   * @param left  Base token for *left* expression (e.g. `"$$el"`)
   * @param right Base token for *right* expression (e.g. `"$$this"`)
   */
  private _keysEqual(keys: string[], left: string, right: string): any {
    const eqs = keys.map((k) => ({ $eq: [`${left}.${k}`, `${right}.${k}`] }));
    return eqs.length === 1 ? eqs[0] : { $and: eqs };
  }

  // ---------------------------------------------------------------------------
  //  Individual MongoDB operators – each method adds a chunk to `updateObj`.
  // ---------------------------------------------------------------------------

  /**
   * `$replace` – overwrite the entire array with `input`.
   *
   * @param key   Dotted path to the array
   * @param input New array value (may be `undefined`)
   * @private
   */
  private _replace(key: string, input: any[] | undefined) {
    if (input) {
      this._set(key, literal(input));
    }
  }

  /**
   * `cond` whether an element of `$$value` (the array being built inside a
   * `$reduce`) has the key(s) of `$$this` (the current item).
   */
  private _keyStored(keys: string[]): Document {
    return {
      $anyElementTrue: {
        $map: { input: "$$value", as: "el", in: this._keysEqual(keys, "$$el", "$$this") },
      },
    };
  }

  /**
   * Items applied one after another: each is appended to the array built so
   * far unless `stored` holds for it — then `whenStored` (default: the
   * array as it is) is the result.
   */
  private _appendUnless(
    key: string,
    input: any[],
    stored: Document,
    whenStored: unknown = "$$value",
  ): void {
    this._set(key, {
      $reduce: {
        input: literal(input),
        initialValue: { $ifNull: [`$${key}`, []] },
        in: { $cond: [stored, whenStored, { $concatArrays: ["$$value", ["$$this"]] }] },
      },
    });
  }

  /**
   * `$insert` — what the read-modify-write of the other adapters does (since
   * 0.1.180; before, a keyed or unique insert was an upsert / a set union):
   * - keyed  → append, skipping an item whose key is already stored
   * - unique → append, skipping an item equal to a stored one
   * - else   → append every item
   */
  private _insert(
    key: string,
    input: any[] | undefined,
    keys: string[],
    flatType: TAtscriptAnnotatedType,
  ) {
    if (!input?.length) {
      return;
    }

    if (keys.length > 0) {
      this._appendUnless(key, input, this._keyStored(keys));
    } else if (flatType.metadata?.has("expect.array.uniqueItems")) {
      this._appendUnless(key, input, { $in: ["$$this", "$$value"] });
    } else {
      this._set(key, {
        $concatArrays: [{ $ifNull: [`$${key}`, []] }, literal(input)],
      });
    }
  }

  /**
   * `$upsert` — as on the other adapters (since 0.1.180; before, a keyed
   * upsert moved the element to the end and a key-less one was a set union,
   * which also dropped duplicates already stored):
   * - keyed    → replace / merge into the element(s) of that key in place,
   *              or append when none has it
   * - key-less → append unless an equal element is stored
   */
  private _upsert(
    key: string,
    input: any[] | undefined,
    keys: string[],
    flatType: TAtscriptAnnotatedType,
  ) {
    if (!input?.length) {
      return;
    }

    if (keys.length === 0) {
      this._appendUnless(key, input, { $in: ["$$this", "$$value"] });
      return;
    }

    const mergeStrategy = flatType.metadata?.get("db.patch.strategy") === "merge";
    this._appendUnless(key, input, this._keyStored(keys), {
      $map: {
        input: "$$value",
        as: "el",
        in: {
          $cond: [
            this._keysEqual(keys, "$$el", "$$this"),
            mergeStrategy ? { $mergeObjects: ["$$el", "$$this"] } : "$$this",
            "$$el",
          ],
        },
      },
    });
  }

  /**
   * `$update`
   * - keyed       → map array and merge / replace matching element(s)
   * - non-keyed   → nothing: there is no key to find an element by (since
   *   0.1.180, as on every other adapter; before, the items were added to
   *   the array as a set union)
   */
  private _update(
    key: string,
    input: any[] | undefined,
    keys: string[],
    flatType: TAtscriptAnnotatedType,
  ) {
    if (!input?.length || keys.length === 0) {
      return;
    }

    const mergeStrategy = flatType.metadata?.get("db.patch.strategy") === "merge";

    // sequentially apply each patch item
    this._set(key, {
      $reduce: {
        input: literal(input),
        initialValue: { $ifNull: [`$${key}`, []] },
        in: {
          $map: {
            input: "$$value",
            as: "el",
            in: {
              $cond: [
                this._keysEqual(keys, "$$el", "$$this"),
                mergeStrategy
                  ? { $mergeObjects: ["$$el", "$$this"] } // merge
                  : "$$this", // replace
                "$$el",
              ],
            },
          },
        },
      },
    });
  }

  /**
   * `$remove`
   * - keyed    → filter out any element whose key set matches a payload item
   * - key-less → filter out every element equal to a payload item (since
   *              0.1.180; before, a `$setDifference`, which also dropped
   *              duplicates of the elements that stay)
   */
  private _remove(
    key: string,
    input: any[] | undefined,
    keys: string[],
    _flatType: TAtscriptAnnotatedType,
  ) {
    if (!input?.length) {
      return;
    }

    const stored = { $ifNull: [`$${key}`, []] };
    if (keys.length > 0) {
      this._set(key, {
        $let: {
          vars: { rem: literal(input) },
          in: {
            $filter: {
              input: stored,
              as: "el",
              cond: {
                $not: {
                  $anyElementTrue: {
                    $map: {
                      input: "$$rem",
                      as: "r",
                      in: this._keysEqual(keys, "$$el", "$$r"),
                    },
                  },
                },
              },
            },
          },
        },
      });
    } else {
      this._set(key, {
        $filter: { input: stored, as: "el", cond: { $not: { $in: ["$$el", literal(input)] } } },
      });
    }
  }
}

/**
 * Whether a plain-object patch value replaces the stored object instead of
 * merging into it: a `@db.json` object, or a union of objects / `T | null`
 * whose member may switch (since 0.1.155). A field the patcher cannot type
 * (e.g. under a `@db.column` name) keeps the merge.
 */
function replacesWhole(value: unknown, type: TAtscriptAnnotatedType | undefined): boolean {
  if (!type || !isPlainObject(value)) return false;
  return type.metadata?.has("db.json") || type.type.kind === "union";
}
