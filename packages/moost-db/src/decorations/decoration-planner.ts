import type { TMetaResponse, UniqueryControls } from "@atscript/db";
import { isPlainObject, selfOrAncestor } from "@atscript/db";
import type { TSerializedAnnotatedType } from "@atscript/typescript/utils";

import type { FieldCapabilityIndex } from "../meta/field-capabilities";
import { selectShape } from "../select-shape";
import type { TDecorationIndex } from "./decoration-index";

type TSelect = UniqueryControls["$select"] | undefined;

export const NO_DECORATIONS: ReadonlySet<string> = new Set();

/** What a read does about the declared decorations — see {@link DecorationPlanner.plan}. */
export interface TDecorationPlan {
  /** The wire `$select` with decoration keys removed and their `requires` added (what `transformProjection` sees). */
  select: TSelect;
  /** The decoration keys the response should carry, before the visibility / projection check. */
  requested: readonly string[];
  /** `requires` paths added only for the hook — stripped from the response. */
  requiresOnly: readonly string[];
  /**
   * The client's own inclusion paths: of a `requiresOnly` path read for the
   * hook, a descendant the client selected itself stays in the response.
   */
  selected?: readonly string[];
}

/** The decoration step of a finished read: the keys served and what to strip from the rows. */
export interface TDecorationRead {
  served: ReadonlySet<string>;
  /** Declared keys that are not served (dot-free top-level keys). */
  dropKeys: readonly string[];
  /** `requires` paths added only for the hook, split once per read. */
  dropPaths: readonly (readonly string[])[];
  /** Per drop path, the client-selected paths below it that survive the strip (dot-split). */
  keepPaths: readonly (readonly (readonly string[])[])[];
  /**
   * The client's own inclusion paths (dot-split) — set for an inclusion read
   * only. A strip then also removes a parent it emptied (or a `null` one)
   * unless the client selected something at or below it; an exclusion read
   * leaves a parent as a plain read would.
   */
  selectedPaths?: readonly (readonly string[])[];
}

/** What the planner reads of the controller it serves. */
export interface TDecorationHost {
  /** The request's field visibility (`hasField` ∧ derived sources). */
  readonly isVisible: (path: string) => boolean;
  /** The capability index the decorations are virtual entries of. */
  capabilities(): FieldCapabilityIndex;
  /** The `preferredId` paths (the response carries them anyway). */
  readonly preferred: ReadonlySet<string>;
  /** `true` while visibility is request-scoped (`hasField` overridden): nothing is memoized. */
  readonly scoped: boolean;
  /** The first own visible field — what an otherwise empty inclusion reads (and strips again). */
  firstVisibleField(): string | undefined;
}

/**
 * The decoration plumbing of one controller (`@DbDecorations`, since 0.1.148):
 * rewrites a read's `$select` ({@link plan}), decides what the response
 * carries once the final projection is known ({@link serve}), and builds the
 * `/meta` view ({@link meta}). The request gate is not here — decorations are
 * virtual entries of the {@link FieldCapabilityIndex}.
 */
export class DecorationPlanner {
  constructor(
    private readonly index: TDecorationIndex,
    private readonly host: TDecorationHost,
  ) {}

  private visible(key: string): boolean {
    return this.host.capabilities().decorationVisible(key, this.host.isVisible);
  }

  private requiresOf(keys: readonly string[]): string[] {
    return [...new Set(keys.flatMap((key) => this.index.requires.get(key)!))];
  }

  /**
   * Splits the wire `$select` of a read (non-grouped: the gate already
   * refused a decoration in a grouped one): `requested` is every declared
   * decoration key whose sources are visible and that the client named — or,
   * without a `$select`, all of them (an exclusion map: all minus the excluded
   * ones). The real `$select` is widened by the requested keys' `requires`;
   * the paths added only for the hook (`requiresOnly`) are stripped again.
   * The result keeps the representation of `raw` (array or map).
   */
  plan(raw: unknown): TDecorationPlan {
    const { keySet, keys } = this.index;
    const shape = selectShape(raw);
    if (shape.kind === "all") {
      return {
        select: undefined,
        requested: keys.filter((k) => this.visible(k)),
        requiresOnly: [],
      };
    }
    const passthrough: TDecorationPlan = {
      select: raw as TSelect,
      requested: [],
      requiresOnly: [],
    };

    if (shape.kind === "list") {
      const named = shape.items.filter(
        (item): item is string => typeof item === "string" && keySet.has(item),
      );
      if (named.length === 0) return passthrough;
      const real = shape.items.filter((item) => !(typeof item === "string" && keySet.has(item)));
      const have = new Set(real.filter((item): item is string => typeof item === "string"));
      return this.inclusion([...new Set(named)], real, have, (list) => list as TSelect);
    }

    const { map, included, excluded } = shape;
    if (included.length === 0 && excluded.length > 0) {
      // Exclusion: every declared key but the excluded ones; a `requires` path
      // the client excluded is read for the hook and stripped again.
      const skip = new Set(excluded);
      const requested = keys.filter((key) => !skip.has(key) && this.visible(key));
      const real = Object.fromEntries(Object.entries(map).filter(([k]) => !keySet.has(k)));
      // A required path the client excluded — itself or through an excluded ancestor — is
      // un-excluded (the whole excluded entry is read) and stripped again. An excluded
      // DESCENDANT of a required path is un-excluded too (the hook reads the path
      // fully) and only that descendant is stripped again.
      const requiresOnly = new Set<string>();
      const remaining = new Set(Object.keys(real));
      const unexclude = (key: string): void => {
        requiresOnly.add(key);
        remaining.delete(key);
        delete real[key];
      };
      for (const path of this.requiresOf(requested)) {
        const hit = selfOrAncestor(path, remaining);
        if (hit !== undefined) {
          unexclude(hit);
          continue;
        }
        const prefix = `${path}.`;
        for (const key of remaining) if (key.startsWith(prefix)) unexclude(key);
      }
      return {
        select: Object.keys(real).length > 0 ? (real as TSelect) : undefined,
        requested,
        requiresOnly: [...requiresOnly],
      };
    }
    const named = included.filter((k) => keySet.has(k));
    if (named.length === 0) return passthrough;
    const real = included.filter((k) => !keySet.has(k));
    return this.inclusion(
      named,
      real,
      new Set(real),
      (list) => Object.fromEntries(list.map((k) => [k, 1])) as TSelect,
    );
  }

  /**
   * The inclusion forms: `real` (the client's own selection) plus the
   * requested decorations' `requires` that it lacks, re-emitted by `emit`.
   */
  private inclusion(
    named: readonly string[],
    real: readonly unknown[],
    have: ReadonlySet<string>,
    emit: (list: unknown[]) => TSelect,
  ): TDecorationPlan {
    const requested = named.filter((key) => this.visible(key));
    // A path the client already selected — itself or through a selected ancestor — is
    // neither added nor stripped: it is the client's data.
    const extra = this.requiresOf(requested).filter(
      (path) => selfOrAncestor(path, have) === undefined,
    );
    const { list, added } = this.nonEmptyInclusion([...real, ...extra]);
    return {
      select: emit(list),
      requested,
      requiresOnly: [...extra.filter((path) => !this.host.preferred.has(path)), ...added],
      selected: [...have],
    };
  }

  /**
   * An inclusion list is never empty (an empty one selects everything): a
   * request naming only decorations with nothing to read selects the
   * `preferredId` fields (which the response carries anyway) or, without one,
   * a single visible field that is stripped again (`added`).
   */
  private nonEmptyInclusion(list: unknown[]): { list: unknown[]; added: string[] } {
    if (list.length > 0) return { list, added: [] };
    const { preferred } = this.host;
    if (preferred.size > 0) return { list: [...preferred], added: [] };
    const field = this.host.firstVisibleField();
    return field === undefined ? { list, added: [] } : { list: [field], added: [field] };
  }

  /**
   * The decoration step once the final projection is known: a requested key
   * is served only if every `requires` path survived `transformProjection`,
   * the seal and the preferred-id widening (a policy that strips a source
   * silently drops the decoration, as it drops a field). `kept` is the final
   * projection's paths (`null` = every field).
   */
  serve(plan: TDecorationPlan, kept: readonly string[] | null): TDecorationRead {
    const { keys, requires, leavesOf } = this.index;
    // A path survives when it, an ancestor, or — for a parent object a policy
    // narrowed to leaves — every own leaf below it is in the projection.
    const carried = (path: string, set: ReadonlySet<string>): boolean =>
      selfOrAncestor(path, set) !== undefined ||
      (leavesOf.get(path)?.every((leaf) => selfOrAncestor(leaf, set) !== undefined) ?? false);
    const dropPaths = plan.requiresOnly.map((path) => path.split("."));
    const keepPaths = plan.requiresOnly.map((path) =>
      (plan.selected ?? [])
        .filter((sel) => sel.startsWith(`${path}.`))
        .map((sel) => sel.split(".")),
    );
    const selectedPaths = plan.selected?.map((sel) => sel.split("."));
    if (plan.requested.length === 0) {
      return { served: NO_DECORATIONS, dropKeys: keys, dropPaths, keepPaths, selectedPaths };
    }
    const keptSet = kept === null ? undefined : new Set(kept);
    const served = new Set(
      plan.requested.filter(
        (key) =>
          keptSet === undefined || requires.get(key)!.every((path) => carried(path, keptSet)),
      ),
    );
    return {
      served,
      dropKeys: keys.filter((key) => !served.has(key)),
      dropPaths,
      keepPaths,
      selectedPaths,
    };
  }

  /**
   * The `/meta` envelope with the declared decorations: each one still
   * present in `decorations` (an overlay may delete props to hide a
   * decoration per principal) whose sources are visible is kept and gets its
   * `fields[key]` entry (from its virtual capability-index entry); the others
   * are pruned, and `decorations` is dropped when none is left. Runs after
   * `applyMetaOverlay` — an overlay never sees the decoration `fields`
   * entries. Memoized per input while visibility is not request-scoped.
   */
  meta(meta: TMetaResponse): TMetaResponse {
    if (!meta.decorations) return meta;
    const { memo, keySet } = this.index;
    const memoize = !this.host.scoped;
    const hit = memoize ? memo.meta.get(meta) : undefined;
    if (hit) return hit;
    const capabilities = this.host.capabilities();
    const props = (meta.decorations.type as { props?: Record<string, never> }).props ?? {};
    const kept: Record<string, never> = {};
    const fields = { ...meta.fields };
    for (const [key, prop] of Object.entries(props)) {
      const cap =
        keySet.has(key) && this.visible(key) ? capabilities.decorationCap(key) : undefined;
      if (!cap) continue;
      kept[key] = prop;
      fields[key] = { sortable: cap.sortable, filterable: cap.filterable, decoration: true };
    }
    let out: TMetaResponse;
    if (Object.keys(kept).length === 0) {
      const { decorations: _dropped, ...rest } = meta;
      out = rest;
    } else {
      out = {
        ...meta,
        fields,
        decorations: { ...meta.decorations, type: { ...meta.decorations.type, props: kept } },
      } as TMetaResponse;
    }
    if (memoize) memo.meta.set(meta, out);
    return out;
  }

  /** The declared interface serialized for `/meta.decorations`, once per class. */
  serialized(serialize: () => TSerializedAnnotatedType): TSerializedAnnotatedType {
    return (this.index.memo.serialized ??= serialize());
  }
}

/** Removes what a read must not carry — the unserved declared keys and the hook-only paths — from `rows`. */
export function stripDecorations(
  rows: readonly Record<string, unknown>[],
  read: TDecorationRead,
): void {
  const { dropKeys, dropPaths, keepPaths, selectedPaths } = read;
  if (dropKeys.length === 0 && dropPaths.length === 0) return;
  // a parent the client selected something at or below is its own data
  const owned = (prefix: readonly string[]): boolean =>
    selectedPaths !== undefined &&
    selectedPaths.some((sel) => prefix.every((part, i) => sel[i] === part));
  for (const row of rows) {
    for (const key of dropKeys) delete row[key];
    dropPaths.forEach((parts, i) => {
      const keep = keepPaths[i] ?? [];
      if (keep.length === 0) deleteDescending(row, parts, 0, selectedPaths !== undefined, owned);
      else pruneExcept(row, parts, 0, keep);
    });
  }
}

/** An object without keys, or an array (of any nesting) holding nothing but such values (what a strip left of a parent). */
function isHollow(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((el) => isHollow(el));
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/**
 * Deletes the path `parts` below `value`, descending through arrays of objects
 * (`items.qty` strips every element's `qty`). With `clean` (an inclusion read),
 * a parent the strip emptied — or a `null` one — goes too, unless the client
 * selected something at or below it.
 */
function deleteDescending(
  value: unknown,
  parts: readonly string[],
  depth: number,
  clean: boolean,
  owned: (prefix: readonly string[]) => boolean,
): void {
  if (Array.isArray(value)) {
    // an element the strip emptied leaves the array (the array itself, once
    // nothing but hollow elements remain, is dropped by its parent)
    const dropEmptied = clean && depth > 0 && !owned(parts.slice(0, depth));
    for (let i = value.length - 1; i >= 0; i--) {
      const el = value[i];
      const wasHollow = isHollow(el);
      deleteDescending(el, parts, depth, clean, owned);
      if (dropEmptied && !wasHollow && isHollow(el)) {
        value.splice(i, 1);
      }
    }
    return;
  }
  if (!isPlainObject(value)) return;
  const key = parts[depth];
  if (depth === parts.length - 1) {
    delete value[key];
    return;
  }
  const child = value[key];
  const prefix = parts.slice(0, depth + 1);
  if (child === null && clean && !owned(prefix)) {
    delete value[key];
    return;
  }
  deleteDescending(child, parts, depth + 1, clean, owned);
  if (clean && isHollow(child) && !owned(prefix)) {
    delete value[key];
  }
}

/**
 * Below `parts`, deletes everything except the branches leading to `keep`
 * (client-selected descendants), through arrays of objects as well.
 */
function pruneExcept(
  value: unknown,
  parts: readonly string[],
  depth: number,
  keep: readonly (readonly string[])[],
): void {
  if (Array.isArray(value)) {
    for (const el of value) pruneExcept(el, parts, depth, keep);
    return;
  }
  if (!isPlainObject(value)) return;
  if (depth < parts.length) {
    pruneExcept(value[parts[depth]], parts, depth + 1, keep);
    return;
  }
  prune(
    value,
    parts.length,
    keep.filter((k) => k.length > parts.length),
  );
}

function prune(value: unknown, depth: number, branches: readonly (readonly string[])[]): void {
  if (Array.isArray(value)) {
    for (const el of value) prune(el, depth, branches);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    const next = branches.filter((b) => b[depth] === key);
    if (next.length === 0) delete value[key];
    else if (next.some((b) => b.length > depth + 1)) prune(value[key], depth + 1, next);
  }
}

/** `true` when stripping `read` changes nothing — skip the post-hook step. */
export function stripsNothing(read: TDecorationRead | undefined): boolean {
  return read === undefined || (read.dropKeys.length === 0 && read.dropPaths.length === 0);
}
