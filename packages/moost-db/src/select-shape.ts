/**
 * A wire `$select` split into its representation: no `$select` at all, an
 * array (field names and computed entries, in order), or a map with its
 * included (`1` / `true`) and excluded (`0` / `false`) keys.
 */
export type TSelectShape =
  | { kind: "all" }
  | { kind: "list"; items: readonly unknown[] }
  | {
      kind: "map";
      map: Readonly<Record<string, unknown>>;
      included: readonly string[];
      excluded: readonly string[];
    };

/** The included (`1` / `true`) and excluded (`0` / `false`) keys of a `$select` map. */
export function mapShape(map: Readonly<Record<string, unknown>>): {
  included: string[];
  excluded: string[];
} {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (value === 1 || value === true) included.push(key);
    else if (value === 0 || value === false) excluded.push(key);
  }
  return { included, excluded };
}

/** The one splitter every `$select` consumer in the controller reads. */
export function selectShape(raw: unknown): TSelectShape {
  if (raw === undefined || raw === null) return { kind: "all" };
  if (Array.isArray(raw)) return { kind: "list", items: raw };
  const map = raw as Record<string, unknown>;
  return { kind: "map", map, ...mapShape(map) };
}
