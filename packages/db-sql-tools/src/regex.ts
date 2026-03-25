/**
 * Parses a regex value that may be a RegExp object, a `/pattern/flags` string,
 * or a raw pattern string. Returns the extracted pattern and flags.
 *
 * Handles the format produced by `@uniqu/url@0.1.4+` where regex values
 * arrive as strings like `"/^Ali/i"` instead of raw patterns.
 */
export function parseRegexString(value: unknown): { pattern: string; flags: string } {
  if (value instanceof RegExp) {
    return { pattern: value.source, flags: value.flags };
  }
  const str = String(value);
  const match = str.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    return { pattern: match[1]!, flags: match[2]! };
  }
  return { pattern: str, flags: "" };
}
