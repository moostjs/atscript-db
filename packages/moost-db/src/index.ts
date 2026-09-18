export * from "./as-readable.controller";
export * from "./as-db-readable.controller";
export * from "./as-db.controller";
export * from "./as-value-help.controller";
export * from "./as-json-value-help.controller";
export * from "./decorators";
export * from "./db-space-registry";
export * from "./assert-exposed";
export * from "./validation-interceptor";
export * from "./actions";
export {
  type AtscriptDbMate,
  type AtscriptDbMeta,
  type AtscriptDbParamsMeta,
  type TReadableBindingMeta,
  getAtscriptDbMate,
} from "./mate";

export { QUERY_CONTROLS, PAGES_CONTROLS, ONE_CONTROLS } from "./permissions/crud-controls";

// Re-export the action + permission types from @atscript/db so consumers can
// import them from `@atscript/moost-db` in a single line.
export type {
  TDbActionInfo,
  TDbActionLevel,
  TDbActionIntent,
  TDbActionProcessor,
  TCrudOp,
  TCrudPermissions,
} from "@atscript/db";

// ── Capability index + terminal refs (since 0.1.128) ────────────────────────
export {
  FieldCapabilityIndex,
  type TFieldCapability,
  type TCapabilityReadable,
  type TCapabilityVerdict,
} from "./meta/field-capabilities";
export { applyTerminalRefs, resolveTerminalRef, resolveProp } from "./meta/terminal-ref";
export type { TTerminalRef } from "./meta/terminal-ref";
// The structural query walker and its op / refs types live in the core (one
// walker for the HTTP gate and the core backstop) — re-exported for convenience.
export { collectQueryPaths } from "@atscript/db";
export type { TQueryPathOp, TQueryPathRefs } from "@atscript/db";
export { badRequest, errorEnvelope } from "./http-errors";
export type { THttpErrorEntry } from "./http-errors";

// Validated-stage guard contexts for `AsDbController.guardWrite` / `guardRemove`
// (since 0.1.128) — re-exported so controllers need a single import.
export type { TDbWriteAction, TDbWriteGuardContext, TDbRemoveGuardContext } from "@atscript/db";
