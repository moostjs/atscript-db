import {
  deserializeAnnotatedType,
  type TAtscriptAnnotatedType,
  type TAtscriptTypeObject,
  type Validator,
} from "@atscript/typescript/utils";
import {
  buildDbValidator,
  buildValidationContext,
  DbError,
  reconcileCas,
  type DbValidationContext,
  type ValidatorMode,
} from "@atscript/db/validator";

import type { MetaResponse } from "./types";

export type { DbValidationContext, ValidatorMode } from "@atscript/db/validator";

/** Options for {@link ClientValidator} / {@link createClientValidator}. */
export interface ClientValidatorOptions {
  /**
   * The table's `@db.column.version` column (from `/meta`'s `versionColumn`).
   * Enables the `$cas` lift in {@link ClientValidator.liftCas}; without it a
   * `$cas` payload is rejected (the table is not versioned).
   */
  versionColumn?: string;
  /**
   * Tolerate unknown properties in write payloads. Enable when the served
   * `/meta` type is a PROJECTION of the full server-side type (e.g. an ARBAC
   * read overlay that strips write-only fields such as sealed credentials) —
   * otherwise a legitimate write carrying such a field is rejected client-side
   * while the server would accept it. The server stays authoritative; this
   * only relaxes the client preflight, so leave it off unless you need it
   * (strict preflight catches typos).
   */
  lenientWrites?: boolean;
}

/**
 * Client-side validator backed by an Atscript type from the `/meta` endpoint.
 *
 * Caches validators per mode. Lazily initializes from a meta response promise.
 */
export class ClientValidator {
  private _type: TAtscriptAnnotatedType<TAtscriptTypeObject>;
  private _validators = new Map<string, Validator<any>>();
  private _lenientWrites: boolean;

  /** Flat map of dotted field paths to their annotated types. */
  readonly flatMap: Map<string, TAtscriptAnnotatedType>;

  /** Set of field paths that are navigation relations (TO/FROM/VIA). */
  readonly navFields: ReadonlySet<string>;

  /** The table's version column when it opts into OCC (from `/meta`). */
  readonly versionColumn?: string;

  constructor(type: TAtscriptAnnotatedType<TAtscriptTypeObject>, opts?: ClientValidatorOptions) {
    this._type = type;
    this._lenientWrites = opts?.lenientWrites === true;
    this.versionColumn = opts?.versionColumn;
    const ctx = buildValidationContext(type);
    this.flatMap = ctx.flatMap;
    this.navFields = ctx.navFields;
  }

  /**
   * Normalises the SDK `$cas` shape to the wire shape (since 0.1.128):
   * `{ id, $cas: { version: 4 } }` → `{ id, version: 4 }` (the server lifts
   * `version` back to `$cas`). Returns a shallow clone per item; items
   * without `$cas` (a `$cas: undefined` counts as absent) are returned
   * as-is. Throws `ClientValidationError` when the table is not versioned,
   * the `$cas` shape is invalid, or `version` and `$cas` disagree — the same
   * messages the server produces, from the shared `reconcileCas` — or when
   * `$cas` appears on an insert.
   */
  liftCas(data: unknown, mode: ValidatorMode): unknown {
    if (Array.isArray(data)) {
      return data.map((item, i) => this._liftCasItem(item, mode, `[${i}].`));
    }
    return this._liftCasItem(data, mode, "");
  }

  private _liftCasItem(item: unknown, mode: ValidatorMode, prefix: string): unknown {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const cas = (item as Record<string, unknown>).$cas;
    if (cas === undefined) return item;
    const path = `${prefix}$cas`;
    if (mode === "insert") {
      throw new ClientValidationError([{ path, message: "$cas is not allowed on insert" }]);
    }
    const clone = { ...(item as Record<string, unknown>) };
    try {
      reconcileCas(clone, this.versionColumn, "version");
    } catch (e) {
      if (e instanceof DbError) {
        throw new ClientValidationError(
          e.errors.map((err) => ({ path: `${prefix}${err.path}`, message: err.message })),
        );
      }
      throw e;
    }
    return clone;
  }

  /**
   * Validate data for a given write mode.
   * Throws `ClientValidationError` if validation fails.
   */
  validate(data: unknown, mode: ValidatorMode): void {
    const isArray = Array.isArray(data);
    const items = isArray ? data : [data];
    const validator = this._getValidator(mode);
    const ctx: DbValidationContext = { mode, flatMap: this.flatMap, navFields: this.navFields };
    for (let i = 0; i < items.length; i++) {
      if (!validator.validate(items[i], true, ctx)) {
        const prefix = isArray ? `[${i}]` : "";
        const errors = validator.errors.map((e) => ({
          path: prefix ? (e.path ? `${prefix}.${e.path}` : prefix) : e.path,
          message: e.message,
        }));
        throw new ClientValidationError(errors);
      }
    }
  }

  private _getValidator(mode: ValidatorMode): Validator<any> {
    let v = this._validators.get(mode);
    if (!v) {
      v = buildDbValidator(
        this._type,
        mode,
        undefined,
        this._lenientWrites ? { unknownProps: "ignore" } : undefined,
      );
      this._validators.set(mode, v);
    }
    return v;
  }
}

/**
 * Structured validation error thrown before HTTP requests when client-side
 * validation fails.
 */
export class ClientValidationError extends Error {
  readonly errors: Array<{ path: string; message: string }>;

  constructor(errors: Array<{ path: string; message: string }>) {
    const msg =
      errors.length === 1 ? errors[0].message : `Validation failed with ${errors.length} errors`;
    super(msg);
    this.name = "ClientValidationError";
    this.errors = errors;
  }
}

/**
 * Create a {@link ClientValidator} from a meta response (or promise).
 *
 * @example
 * ```typescript
 * const client = new Client<typeof User>('/db/tables/users')
 * const validator = createClientValidator(await client.meta())
 * validator.validate({ name: 'foo' }, 'insert')
 * ```
 */
export function createClientValidator(
  meta: MetaResponse,
  opts?: ClientValidatorOptions,
): ClientValidator {
  const type = deserializeAnnotatedType(meta.type) as TAtscriptAnnotatedType<TAtscriptTypeObject>;
  return new ClientValidator(type, { versionColumn: meta.versionColumn, ...opts });
}
