import type { TMetaResponse, UniqueryControls } from "@atscript/db";
import { deletePath, selfOrAncestor } from "@atscript/db";
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
}

/** The decoration step of a finished read: the keys served and what to strip from the rows. */
export interface TDecorationRead {
  served: ReadonlySet<string>;
  /** Declared keys that are not served (dot-free top-level keys). */
  dropKeys: readonly string[];
  /** `requires` paths added only for the hook, split once per read. */
  dropPaths: readonly (readonly string[])[];
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
      // un-excluded (the whole excluded entry is read) and stripped again.
      const requiresOnly = new Set<string>();
      for (const path of this.requiresOf(requested)) {
        const hit = selfOrAncestor(path, new Set(Object.keys(real)));
        if (hit === undefined) continue;
        requiresOnly.add(hit);
        delete real[hit];
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
    const { keys, requires } = this.index;
    const dropPaths = plan.requiresOnly.map((path) => path.split("."));
    if (plan.requested.length === 0) {
      return { served: NO_DECORATIONS, dropKeys: keys, dropPaths };
    }
    const keptSet = kept === null ? undefined : new Set(kept);
    const served = new Set(
      plan.requested.filter(
        (key) =>
          keptSet === undefined ||
          requires.get(key)!.every((path) => selfOrAncestor(path, keptSet) !== undefined),
      ),
    );
    return { served, dropKeys: keys.filter((key) => !served.has(key)), dropPaths };
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
  const { dropKeys, dropPaths } = read;
  if (dropKeys.length === 0 && dropPaths.length === 0) return;
  for (const row of rows) {
    for (const key of dropKeys) delete row[key];
    for (const parts of dropPaths) deletePath(row, parts);
  }
}

/** `true` when stripping `read` changes nothing — skip the post-hook step. */
export function stripsNothing(read: TDecorationRead | undefined): boolean {
  return read === undefined || (read.dropKeys.length === 0 && read.dropPaths.length === 0);
}
