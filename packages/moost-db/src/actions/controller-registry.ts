import { getAtscriptDbMate } from "../mate";
import { WARN_PREFIX } from "./keys";

// Late binding avoids an import cycle with the controller classes.
// Decoration-time only: prototype-chain check. Runtime table lookup is
// duck-typed (see `id-cache.controllerTable`) — `instanceof` breaks when
// moost-db loads in two module realms (moost-vite SSR).

let asDbReadableCtor: Function | null = null;
let asValueHelpCtor: Function | null = null;

export function registerAsDbReadableController(ctor: Function): void {
  asDbReadableCtor = ctor;
}

export function registerAsValueHelpController(ctor: Function): void {
  asValueHelpCtor = ctor;
}

export function isAsDbReadableControllerSubclass(ctor: Function): boolean {
  if (!asDbReadableCtor) return false;
  return asDbReadableCtor.prototype.isPrototypeOf(ctor.prototype);
}

export function isAsValueHelpControllerSubclass(ctor: Function): boolean {
  if (!asValueHelpCtor) return false;
  return asValueHelpCtor.prototype.isPrototypeOf(ctor.prototype);
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
