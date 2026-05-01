import { ValidatorError } from "@atscript/typescript/utils";
import type { TDbFieldMeta, TIdentification } from "@atscript/db";

interface IdError {
  path: string;
  message: string;
  details?: IdError[];
}

/** Duck-typed shape; matches `AtscriptDbReadable`'s public surface. */
export interface IdValidationSource {
  readonly identifications: readonly TIdentification[];
  readonly fieldDescriptors: readonly TDbFieldMeta[];
}

interface SourceCache {
  byKeySig: Map<string, TIdentification>;
  fieldByName: Map<string, TDbFieldMeta>;
  formatted: string;
}

const SOURCE_CACHE = new WeakMap<IdValidationSource, SourceCache>();

function getSourceCache(source: IdValidationSource): SourceCache {
  let cache = SOURCE_CACHE.get(source);
  if (cache) return cache;
  const identifications = source.identifications;
  const byKeySig = new Map<string, TIdentification>();
  for (const ident of identifications) {
    byKeySig.set(fieldsSig(ident.fields), ident);
  }
  const fieldByName = new Map<string, TDbFieldMeta>();
  for (const fd of source.fieldDescriptors) {
    fieldByName.set(fd.path, fd);
  }
  const formatted = identifications.map((id) => `[${id.fields.join(", ")}]`).join(", ");
  cache = { byKeySig, fieldByName, formatted };
  SOURCE_CACHE.set(source, cache);
  return cache;
}

function fieldsSig(fields: readonly string[]): string {
  return fields.toSorted().join("\x1f");
}

export function isIdValidationSource(value: unknown): value is IdValidationSource {
  if (!value || typeof value !== "object") return false;
  const v = value as { identifications?: unknown; fieldDescriptors?: unknown };
  return Array.isArray(v.identifications) && Array.isArray(v.fieldDescriptors);
}

export function validateSingleId(
  body: unknown,
  source: IdValidationSource,
  path = "",
): Record<string, unknown> {
  const errors = collectIdErrors(body, source, path);
  if (errors.length > 0) {
    throw new ValidatorError(errors);
  }
  return body as Record<string, unknown>;
}

export function validateMultiId(
  body: unknown,
  source: IdValidationSource,
): Record<string, unknown>[] {
  if (!Array.isArray(body)) {
    throw new ValidatorError([
      { path: "", message: "Expected JSON array of identifier objects", details: [] },
    ]);
  }

  const errors: IdError[] = [];
  for (let i = 0; i < body.length; i++) {
    errors.push(...collectIdErrors(body[i], source, `[${i}]`));
  }
  if (errors.length > 0) {
    throw new ValidatorError(errors);
  }
  return body as Record<string, unknown>[];
}

function collectIdErrors(
  value: unknown,
  source: IdValidationSource,
  pathPrefix: string,
): IdError[] {
  if (!isPlainObject(value)) {
    return [{ path: pathPrefix, message: "Expected JSON object for row identifier", details: [] }];
  }

  const cache = getSourceCache(source);
  if (cache.byKeySig.size === 0) {
    return [{ path: pathPrefix, message: "Table has no identifier configured", details: [] }];
  }

  const match = cache.byKeySig.get(fieldsSig(Object.keys(value)));
  if (!match) {
    return [
      {
        path: pathPrefix,
        message: `Identifier fields must exactly match one of: ${cache.formatted}`,
        details: [],
      },
    ];
  }

  const errors: IdError[] = [];
  for (const fieldName of match.fields) {
    const sub = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;
    const err = checkScalar(value[fieldName], cache.fieldByName.get(fieldName), sub);
    if (err) errors.push(err);
  }
  return errors;
}

function checkScalar(
  value: unknown,
  fd: TDbFieldMeta | undefined,
  path: string,
): IdError | undefined {
  const expected = fd?.designType ?? "string";
  if (expected === "string" && typeof value !== "string") {
    return scalarMismatch(path, expected, value);
  }
  if (expected === "number" && typeof value !== "number") {
    return scalarMismatch(path, expected, value);
  }
  if (expected === "boolean" && typeof value !== "boolean") {
    return scalarMismatch(path, expected, value);
  }
  return undefined;
}

function scalarMismatch(path: string, expected: string, value: unknown): IdError {
  return {
    path,
    message: `Expected identifier value to be ${expected}, got ${describe(value)}`,
    details: [],
  };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
