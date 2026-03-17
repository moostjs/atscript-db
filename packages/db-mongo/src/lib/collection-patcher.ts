// oxlint-disable max-lines
// oxlint-disable max-depth
import type {
  TAtscriptAnnotatedType,
  TAtscriptTypeArray,
  TValidatorOptions,
  Validator,
} from "@atscript/typescript/utils";
import { getKeyProps, getDbFieldOp } from "@atscript/db";
import type { TFieldOps } from "@atscript/db";
import { type Document, type Filter, type UpdateFilter, type UpdateOptions } from "mongodb";

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
 * CollectionPatcher is a small helper that converts a *patch payload* produced
 * by Atscript into a shape that the official MongoDB driver understands – a
 * triple of `(filter, update, options)` to be fed to `collection.updateOne()`.
 *
 * Supported high‑level operations for *top‑level arrays* (see the attached
 * spreadsheet in the chat):
 *
 * | Payload field | MongoDB operator        | Purpose                                |
 * |-------------- |-------------------------|----------------------------------------|
 * | `$replace`    | full `$set`             | Replace the whole array.               |
 * | `$insert`     | `$push`                 | Append new items (duplicates allowed). |
 * | `$upsert`     | custom                  | Insert or update by *key* (see TODO).  |
 * | `$update`     | `$set` + `arrayFilters` | Update array elements matched by *key* |
 * | `$remove`     | `$pullAll` / `$pull`    | Remove by value or by *key*.           |
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

  /** Builds a MongoDB aggregation expression for an $inc or $mul field op. */
  private _fieldOpExpr(key: string, op: "inc" | "mul", value: number): Document {
    return op === "inc" ? { $add: [`$${key}`, value] } : { $multiply: [`$${key}`, value] };
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
   * Recursively walk through the patch *payload* and convert it into `$set`/…
   * statements. Top‑level arrays are delegated to {@link parseArrayPatch}.
   *
   * @param payload Current payload chunk
   * @param prefix  Dotted path accumulated so far
   * @private
   */
  private flattenPayload(payload: any, prefix = ""): UpdateFilter<any> {
    const evalKey = (k: string) => (prefix ? `${prefix}.${k}` : k) as string;
    for (const [_key, value] of Object.entries(payload)) {
      const key = evalKey(_key);
      const flatType = this.collection.flatMap.get(key);
      const topLevelArray = flatType?.metadata?.get("db.__topLevelArray") as boolean | undefined;
      if (
        typeof value === "object" &&
        !Array.isArray(value) &&
        topLevelArray &&
        !flatType?.metadata?.has("db.json")
      ) {
        this.parseArrayPatch(key, value, flatType!);
      } else if (
        typeof value === "object" &&
        flatType?.metadata?.get("db.patch.strategy") === "merge"
      ) {
        this.flattenPayload(value, key);
      } else if (key !== "_id") {
        // Detect nested field ops and convert to aggregation expressions
        const fieldOp = getDbFieldOp(value);
        if (fieldOp) {
          this._set(key, this._fieldOpExpr(key, fieldOp.op, fieldOp.value));
        } else {
          this._set(key, value);
        }
      }
    }
    return this.updatePipeline;
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

    this._remove(key, toRemove, keys, flatType);
    this._replace(key, toReplace);
    this._insert(key, toInsert, keys, flatType);
    this._upsert(key, toUpsert, keys, flatType);
    this._update(key, toUpdate, keys, flatType);
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
      this._set(key, input);
    }
  }

  /**
   * `$insert`
   * - plain append      → $concatArrays
   * - unique / keyed    → delegate to _upsert (insert-or-update)
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

    const uniqueItems = flatType.metadata?.has("expect.array.uniqueItems");

    if (uniqueItems || keys.length > 0) {
      this._upsert(key, input, keys, flatType);
    } else {
      // classic `$push ... $each`  →  $concatArrays
      this._set(key, {
        $concatArrays: [
          { $ifNull: [`$${key}`, []] },
          input, // literal items
        ],
      });
    }
  }

  /**
   * `$upsert`
   * - keyed  → remove existing matching by key(s) then append candidate
   * - unique → $setUnion (deep equality)
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

    // ── keyed upsert ──────────────────────────────────────────────────────────
    if (keys.length > 0) {
      const mergeStrategy = flatType.metadata?.get("db.patch.strategy") === "merge";

      const vars: Record<string, any> = { acc: "$$value", cand: "$$this" };
      let appendExpr: any = "$$cand";

      if (mergeStrategy) {
        // Find the existing element to merge with
        vars.existing = {
          $arrayElemAt: [
            {
              $filter: {
                input: "$$value",
                as: "el",
                cond: this._keysEqual(keys, "$$el", "$$this"),
              },
            },
            0,
          ],
        };
        appendExpr = {
          $cond: [
            { $ifNull: ["$$existing", false] },
            { $mergeObjects: ["$$existing", "$$cand"] },
            "$$cand",
          ],
        };
      }

      this._set(key, {
        $reduce: {
          input, // literal payload
          initialValue: { $ifNull: [`$${key}`, []] },
          in: {
            $let: {
              vars,
              in: {
                $concatArrays: [
                  {
                    $filter: {
                      input: "$$acc",
                      as: "el",
                      cond: { $not: this._keysEqual(keys, "$$el", "$$cand") },
                    },
                  },
                  [appendExpr],
                ],
              },
            },
          },
        },
      });
      return;
    }

    // ── no key → behave like $addToSet (deep equality) ────────────
    this._set(key, {
      $setUnion: [{ $ifNull: [`$${key}`, []] }, input],
    });
  }

  /**
   * `$update`
   * - keyed       → map array and merge / replace matching element(s)
   * - non-keyed   → behave like `$addToSet` (insert only when not present)
   */
  private _update(
    key: string,
    input: any[] | undefined,
    keys: string[],
    flatType: TAtscriptAnnotatedType,
  ) {
    if (!input?.length) {
      return;
    }

    if (keys.length > 0) {
      const mergeStrategy = flatType.metadata?.get("db.patch.strategy") === "merge";

      // sequentially apply each patch item
      this._set(key, {
        $reduce: {
          input,
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
    } else {
      // non-keyed “update” means insert-if-missing
      this._set(key, {
        $setUnion: [{ $ifNull: [`$${key}`, []] }, input],
      });
    }
  }

  /**
   * `$remove`
   * - keyed     → filter out any element whose key set matches a payload item
   * - non-keyed → deep equality remove (`$setDifference`)
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

    if (keys.length > 0) {
      this._set(key, {
        $let: {
          vars: { rem: input },
          in: {
            $filter: {
              input: { $ifNull: [`$${key}`, []] },
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
      // deep-equality removal for primitives / whole objects
      this._set(key, {
        $setDifference: [{ $ifNull: [`$${key}`, []] }, input],
      });
    }
  }
}
