export { Client, encodeNavigateId, formatIdentifier, formatIdentifierField } from "./client";
export {
  ClientError,
  ActionNotFoundError,
  ActionUnsupportedError,
  ActionDisabledError,
  VersionMismatchError,
} from "./client-error";
export type { ActionDisabledErrorBody, VersionMismatchErrorBody } from "./client-error";

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
  AtscriptClientShape,
  DataOf,
  OwnOf,
  NavOf,
  IdOf,
  ClientResponse,
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
