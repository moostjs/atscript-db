import { getAtscriptDbMate } from "../mate";
import { WARN_PREFIX } from "./keys";

// Class brands (registered symbols, set once on the base classes and
// inherited by every subclass through the constructor chain) instead of
// prototype identity: moost-db may load in two module realms (moost-vite SSR,
// a linked package next to an installed one) and each realm's base class is a
// different object — a brand from either realm is the same symbol. Late
// binding avoids an import cycle with the controller classes.

const READABLE_BRAND = Symbol.for("atscript-db.AsDbReadableController");
const VALUE_HELP_BRAND = Symbol.for("atscript-db.AsValueHelpController");

function brand(ctor: Function, key: symbol): void {
  Object.defineProperty(ctor, key, { value: true, enumerable: false, configurable: true });
}

function hasBrand(ctor: Function, key: symbol): boolean {
  return typeof ctor === "function" && (ctor as unknown as Record<symbol, unknown>)[key] === true;
}

export function registerAsDbReadableController(ctor: Function): void {
  brand(ctor, READABLE_BRAND);
}

export function registerAsValueHelpController(ctor: Function): void {
  brand(ctor, VALUE_HELP_BRAND);
}

/** `ctor` is (or extends) `AsDbReadableController` — of any loaded copy of moost-db. */
export function isAsDbReadableControllerSubclass(ctor: Function): boolean {
  return hasBrand(ctor, READABLE_BRAND);
}

/** `ctor` is (or extends) `AsValueHelpController` — of any loaded copy of moost-db. */
export function isAsValueHelpControllerSubclass(ctor: Function): boolean {
  return hasBrand(ctor, VALUE_HELP_BRAND);
}

/** The error every `@DbAction*` on a value-help controller fails with (since 0.1.143). */
export function valueHelpActionError(ctorName: string, actions: readonly string[]): Error {
  return new Error(
    `${WARN_PREFIX} ${ctorName} is a value-help controller — @DbAction / @DbActions are not supported ` +
      `there (found: ${actions.map((a) => `"${a}"`).join(", ")}). Move the action(s) to an ` +
      `AsDbReadableController / AsDbController.`,
  );
}

const checkedValueHelp = new WeakSet<Function>();

/**
 * Bind-time check for value-help controllers (since 0.1.143): throws when the
 * class — or anything it inherits — carries `@DbAction` / `@DbActions*`
 * metadata. The decorators throw on their own when applied to a value-help
 * subclass directly; this catches actions inherited from a non-value-help
 * base. Memoized per class.
 */
export function assertNoValueHelpActions(ctor: Function): void {
  if (checkedValueHelp.has(ctor)) return;
  const mate = getAtscriptDbMate();
  const found = new Set<string>();
  for (let proto = ctor.prototype; proto && proto !== Object.prototype; ) {
    for (const entry of mate.read(proto.constructor)?.atscript_db_actions ?? []) {
      found.add(entry.name);
    }
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor") continue;
      const action = mate.read(proto, key)?.atscript_db_action;
      if (action) found.add(action.name || key);
    }
    proto = Object.getPrototypeOf(proto);
  }
  if (found.size > 0) throw valueHelpActionError(ctor.name, [...found]);
  checkedValueHelp.add(ctor);
}
