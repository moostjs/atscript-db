export * from "./as-readable.controller";
export * from "./as-db-readable.controller";
export * from "./as-db.controller";
export * from "./as-value-help.controller";
export * from "./as-json-value-help.controller";
export * from "./decorators";
export * from "./validation-interceptor";
export * from "./actions";
export {
  type AtscriptDbMate,
  type AtscriptDbMeta,
  type AtscriptDbParamsMeta,
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
