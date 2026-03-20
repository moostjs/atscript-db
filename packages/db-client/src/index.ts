export { Client } from "./client";
export { ClientError } from "./client-error";
export type {
  ClientOptions,
  MetaResponse,
  PagesResponse,
  SearchIndexInfo,
  RelationInfo,
  FieldMeta,
  ServerError,
  InsertResult,
  InsertManyResult,
  UpdateResult,
  DeleteResult,
  DataOf,
  OwnOf,
  NavOf,
  IdOf,
  DbInterface,
  // Re-exported from @uniqu/core
  FilterExpr,
  UniqueryControls,
  Uniquery,
  AggregateQuery,
  TypedWithRelation,
} from "./types";

// Re-exported from @atscript/typescript for convenience
export type { TSerializedAnnotatedType } from "@atscript/typescript/utils";
