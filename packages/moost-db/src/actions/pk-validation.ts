import { ValidatorError } from "@atscript/typescript/utils";
import type { TDbFieldMeta } from "@atscript/db";

/** Error shape accepted by {@link ValidatorError}. */
interface PkError {
  path: string;
  message: string;
  details?: PkError[];
}

/**
 * Minimal shape required to validate PKs against a table — supplied by the
 * controller's underlying `AtscriptDbReadable`/`AtscriptDbTable`.
 */
export interface PkValidationSource {
  primaryKeys: readonly string[];
  fieldDescriptors: readonly TDbFieldMeta[];
}

/**
 * Validate a JSON-decoded body against a single-row PK shape (scalar or
 * composite). Throws {@link ValidatorError} with structured `errors` so the
 * existing validation interceptor returns HTTP 400.
 */
export function validateSinglePk(body: unknown, source: PkValidationSource, path = ""): void {
  const errors = collectPkErrors(body, source, path);
  if (errors.length > 0) {
    throw new ValidatorError(errors);
  }
}

/**
 * Validate a JSON-decoded body against an array of PK shapes (`@DbActionPKs`).
 * The body MUST be an array; each element is validated against the PK schema.
 */
export function validateMultiPk(body: unknown, source: PkValidationSource): void {
  if (!Array.isArray(body)) {
    throw new ValidatorError([
      { path: "", message: "Expected JSON array of primary keys", details: [] },
    ]);
  }
  const errors: PkError[] = [];
  for (let i = 0; i < body.length; i++) {
    errors.push(...collectPkErrors(body[i], source, `[${i}]`));
  }
  if (errors.length > 0) {
    throw new ValidatorError(errors);
  }
}

function collectPkErrors(
  value: unknown,
  source: PkValidationSource,
  pathPrefix: string,
): PkError[] {
  const pkFields = source.primaryKeys;
  if (pkFields.length === 0) {
    return [{ path: pathPrefix, message: "Table has no primary key configured", details: [] }];
  }
  const errors: PkError[] = [];
  if (pkFields.length === 1) {
    const fd = findFieldDescriptor(source, pkFields[0]);
    const err = checkScalar(value, fd, pathPrefix);
    if (err) errors.push(err);
    return errors;
  }
  if (!isPlainObject(value)) {
    errors.push({
      path: pathPrefix,
      message: "Expected JSON object for composite primary key",
      details: [],
    });
    return errors;
  }
  for (const fieldName of pkFields) {
    const sub = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;
    if (!(fieldName in value)) {
      errors.push({
        path: sub,
        message: `Missing primary-key field "${fieldName}"`,
        details: [],
      });
      continue;
    }
    const fd = findFieldDescriptor(source, fieldName);
    const err = checkScalar((value as Record<string, unknown>)[fieldName], fd, sub);
    if (err) errors.push(err);
  }
  return errors;
}

function findFieldDescriptor(source: PkValidationSource, name: string): TDbFieldMeta | undefined {
  for (const fd of source.fieldDescriptors) {
    if (fd.path === name) return fd;
  }
  return undefined;
}

function checkScalar(
  value: unknown,
  fd: TDbFieldMeta | undefined,
  path: string,
): PkError | undefined {
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

function scalarMismatch(path: string, expected: string, value: unknown): PkError {
  return {
    path,
    message: `Expected primary-key value to be ${expected}, got ${describe(value)}`,
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
