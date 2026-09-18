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
