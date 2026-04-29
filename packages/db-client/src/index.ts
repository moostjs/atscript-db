export { Client } from "./client";
export { ClientError, ActionNotFoundError, ActionUnsupportedError } from "./client-error";

// Re-exported from @atscript/db so consumers building UIs over /meta have a
// single import point for the action + CRUD permission wire types.
export type {
  TDbActionInfo,
  TDbActionLevel,
  TDbActionIntent,
  TDbActionProcessor,
  TCrudOp,
  TCrudPermissions,
} from "@atscript/db";
export type {
  ClientOptions,
  MetaResponse,
  PageResult,
  SearchIndexInfo,
  RelationInfo,
  FieldMeta,
  ServerError,
  DataOf,
  OwnOf,
  NavOf,
  IdOf,
  // Re-exported from @atscript/db
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
  // Re-exported from @uniqu/core
  FilterExpr,
  UniqueryControls,
  Uniquery,
  AggregateQuery,
  AggregateResult,
  TypedWithRelation,
} from "./types";

// Re-exported from @atscript/typescript for convenience
export type { TSerializedAnnotatedType } from "@atscript/typescript/utils";

// Re-export validation types (runtime exports live in @atscript/db-client/validator)
export type { ClientValidator, ClientValidationError, ValidatorMode } from "./validator";
