export { AtscriptDbReadable, resolveDesignType } from "./table/db-readable";
export { DEFAULT_DB_SPACE } from "./shared/consts";
export { TableMetadata } from "./table/table-metadata";
export { FieldMappingStrategy, DocumentFieldMapper } from "./strategies/field-mapping";
export { RelationalFieldMapper } from "./strategies/relational-field-mapper";
export { IntegrityStrategy, NativeIntegrity } from "./strategies/integrity";
export { ApplicationIntegrity } from "./strategies/application-integrity";
export { DbError, CasExhaustedError } from "./db-error";
export type { DbErrorCode } from "./db-error";
export { DbEncryption } from "./encryption";
export type { TDbEncryptionOptions } from "./encryption";
export { assertGeoPoint, guardFilter, guardQuery, guardAggregate } from "./query/query-guards";
export { isGeoPointType, isGeoIndexableType } from "./table/table-metadata";
export { withOptimisticRetry } from "./with-optimistic-retry";
export type { WithOptimisticRetryOptions } from "./with-optimistic-retry";
// ── Shared validator entry (used by both server and @atscript/db-client) ────
export {
  createDbValidatorPlugin,
  buildDbValidator,
  buildValidationContext,
  isNavRelation,
  forceNavNonOptional,
  isDbFieldOp,
  getKeyProps,
  $inc,
  $dec,
  $mul,
  $cas,
  $replace,
  $insert,
  $upsert,
  $update,
  $remove,
} from "./validator";
export type {
  DbValidationContext,
  ValidatorMode,
  ValidationContext,
  TDbFieldOp,
  TDbCas,
  TArrayPatch,
  TDbPatch,
} from "./validator";

// ── Server-only ops (not in ./validator) ────────────────────────────────────
export { getDbFieldOp, separateFieldOps, separateCas } from "./ops";
export type { TFieldOps } from "./ops";

export type { DbResponse } from "./table/db-readable";
export { AtscriptDbTable } from "./table/db-table";
export { AtscriptDbView } from "./table/db-view";
export type { TViewColumnMapping } from "./table/db-view";
export { BaseDbAdapter } from "./base-adapter";
export { DbSpace } from "./table/db-space";
export type { TAdapterFactory, TDbSpaceOptions } from "./table/db-space";
export { UniquSelect } from "./query/uniqu-select";
export { decomposePatch, assertNoVersionWrites } from "./patch/patch-decomposer";
export { translateQueryTree } from "./query/query-tree";
export type {
  TViewPlan,
  TViewJoin,
  AtscriptQueryNode,
  AtscriptQueryFieldRef,
  AtscriptQueryComparison,
  AtscriptRef,
} from "./query/query-tree";
export type {
  DbQuery,
  DbControls,
  FilterExpr,
  FieldOpsFor,
  UniqueryControls,
  Uniquery,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
  TDbIndex,
  TDbIndexField,
  TDbDefaultValue,
  TIdDescriptor,
  TIdentification,
  TDbFieldMeta,
  TValueFormatterPair,
  TDbStorageType,
  TDbIndexType,
  TDbCollation,
  TDbDefaultFn,
  TDbForeignKey,
  TDbReferentialAction,
  TDbRelation,
  TSearchIndexInfo,
  TMetaResponse,
  TRelationInfo,
  TFieldMeta,
  TDbActionInfo,
  TDbActionLevel,
  TDbActionIntent,
  TDbActionProcessor,
  TCrudOp,
  TCrudPermissions,
  TExistingColumn,
  TExistingTableOption,
  TColumnDiff,
  TTableOptionDiff,
  TSyncColumnResult,
  TTableResolver,
  TWriteTableResolver,
  AtscriptDbWritable,
  TCascadeTarget,
  TCascadeResolver,
  TFkLookupResolver,
  TFkLookupTarget,
  TMetadataOverrides,
  WithRelation,
  TypedWithRelation,
  FlatOf,
  PrimaryKeyOf,
  OwnPropsOf,
  NavPropsOf,
  AggregateExpr,
  AggregateFn,
  AggregateControls,
  AggregateQuery,
  AggregateResult,
} from "./types";
export type { TGenericLogger } from "./logger";
export { NoopLogger } from "./logger";
export { createFailureCollector } from "./shared/failure-collector";

// Re-export walker utilities from @uniqu/core for adapter implementations
export { walkFilter, isPrimitive, computeInsights } from "@uniqu/core";
export type { FilterVisitor } from "@uniqu/core";
