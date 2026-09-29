/**
 * Plain object: prototype is `Object.prototype` or `null` — never a class
 * instance (`Date`, `Uint8Array`, `ObjectId`, …) and never an array.
 * Browser-safe; shared by the write paths, the HTTP shape gate and the client.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Zero-allocation emptiness check for a plain object (`{}` → `true`). */
export function isEmptyObject(obj: Record<string, unknown>): boolean {
  for (const _ in obj) return false;
  return true;
}

/**
 * Finds the nearest ancestor of `path` that belongs to `set`.
 * Used by both the build pipeline (in `_classifyFields`) and
 * runtime reconstruction on the Readable.
 */
export function findAncestorInSet(path: string, set: ReadonlySet<string>): string | undefined {
  let pos = path.length;
  while ((pos = path.lastIndexOf(".", pos - 1)) !== -1) {
    const ancestor = path.slice(0, pos);
    if (set.has(ancestor)) {
      return ancestor;
    }
  }
  return undefined;
}

/** `path` itself if it is in `set`, else its nearest ancestor in `set` ({@link findAncestorInSet}). */
export function selfOrAncestor(path: string, set: ReadonlySet<string>): string | undefined {
  return set.has(path) ? path : findAncestorInSet(path, set);
}

/** Splits a dot-path once; an already split path is used as-is. */
function segmentsOf(path: string | readonly string[]): readonly string[] {
  return typeof path === "string" ? path.split(".") : path;
}

/**
 * Reads a dot-path (or its segments) off a nested plain object: `undefined`
 * past a missing step, or a step that is not a plain object (arrays are not
 * descended into — no positional indexing).
 * @since 0.1.141
 */
export function getPath(row: Record<string, unknown>, path: string | readonly string[]): unknown {
  let current: unknown = row;
  for (const seg of segmentsOf(path)) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Deletes a dot-path (or its segments) from a nested plain object; a no-op
 * when an intermediate step is missing or not a plain object.
 * @since 0.1.141
 */
export function deletePath(
  target: Record<string, unknown>,
  path: string | readonly string[],
): void {
  const segments = segmentsOf(path);
  let current: unknown = target;
  for (let i = 0; i < segments.length - 1; i++) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return;
    }
    current = (current as Record<string, unknown>)[segments[i]!];
  }
  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    delete (current as Record<string, unknown>)[segments[segments.length - 1]!];
  }
}
