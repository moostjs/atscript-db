import {
  deserializeAnnotatedType,
  type TAtscriptAnnotatedType,
  type TAtscriptTypeObject,
  type Validator,
} from "@atscript/typescript/utils";
import {
  buildDbValidator,
  buildValidationContext,
  type DbValidationContext,
  type ValidatorMode,
} from "@atscript/db/validator";

import type { MetaResponse } from "./types";

export type { DbValidationContext, ValidatorMode } from "@atscript/db/validator";

/**
 * Client-side validator backed by an Atscript type from the `/meta` endpoint.
 *
 * Caches validators per mode. Lazily initializes from a meta response promise.
 */
export class ClientValidator {
  private _type: TAtscriptAnnotatedType<TAtscriptTypeObject>;
  private _validators = new Map<string, Validator<any>>();

  /** Flat map of dotted field paths to their annotated types. */
  readonly flatMap: Map<string, TAtscriptAnnotatedType>;

  /** Set of field paths that are navigation relations (TO/FROM/VIA). */
  readonly navFields: ReadonlySet<string>;

  constructor(type: TAtscriptAnnotatedType<TAtscriptTypeObject>) {
    this._type = type;
    const ctx = buildValidationContext(type);
    this.flatMap = ctx.flatMap;
    this.navFields = ctx.navFields;
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
      v = buildDbValidator(this._type, mode);
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
export function createClientValidator(meta: MetaResponse): ClientValidator {
  const type = deserializeAnnotatedType(meta.type) as TAtscriptAnnotatedType<TAtscriptTypeObject>;
  return new ClientValidator(type);
}
