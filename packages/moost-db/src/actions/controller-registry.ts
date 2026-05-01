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
