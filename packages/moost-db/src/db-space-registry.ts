import type { DbSpace } from "@atscript/db";
import { DEFAULT_DB_SPACE } from "@atscript/db";

/** Name under which {@link provideDbSpace} registers a space when none is given. */
export { DEFAULT_DB_SPACE } from "@atscript/db";

/**
 * Ambient registry of {@link DbSpace} instances, keyed by name.
 *
 * WHY module-level and not Moost DI: provide factories in the DI container
 * take no arguments (they cannot resolve sibling tokens), and controllers that
 * declare their own constructors never execute the base class's `@Inject`
 * decorations — so a DI-carried space would silently miss both paths. The
 * ambient registry works for every binding form and can be superseded by a
 * DI-native path later without breaking this API.
 */
const spaces = new Map<string, DbSpace>();

/**
 * Registers a {@link DbSpace} for token-based controller binding
 * (`@TableController(Model)`), keyed by `name` (defaults to
 * {@link DEFAULT_DB_SPACE}).
 *
 * Call before `app.init()` — token resolution happens lazily when controllers
 * are instantiated during init. Registering the same name twice replaces the
 * previous space (used by tests).
 *
 * ```ts
 * provideDbSpace(db)                    // "default"
 * provideDbSpace(analyticsDb, "analytics")
 * ```
 */
export function provideDbSpace(space: DbSpace, name: string = DEFAULT_DB_SPACE): void {
  spaces.set(name, space);
}

/**
 * Returns the space registered under `name`, or throws with wiring guidance.
 * Used by the token-form controller decorators; exported for advanced setups.
 */
export function resolveDbSpace(name: string = DEFAULT_DB_SPACE): DbSpace {
  const space = spaces.get(name);
  if (!space) {
    const known = [...spaces.keys()];
    throw new Error(
      `[moost-db] No DbSpace registered under "${name}". ` +
        `Call provideDbSpace(space${name === DEFAULT_DB_SPACE ? "" : `, "${name}"`}) before app.init(). ` +
        (known.length ? `Registered spaces: ${known.join(", ")}.` : "No spaces registered yet."),
    );
  }
  return space;
}

/** Removes all registered spaces. Intended for test teardown. */
export function clearDbSpaces(): void {
  spaces.clear();
}
