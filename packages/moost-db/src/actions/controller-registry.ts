// Late binding avoids an import cycle with the controller classes.

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

export function isAsDbReadableControllerInstance(value: unknown): boolean {
  return (
    !!asDbReadableCtor && value instanceof (asDbReadableCtor as new (...args: unknown[]) => unknown)
  );
}
