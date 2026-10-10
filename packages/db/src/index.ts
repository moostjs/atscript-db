export { AtscriptDbReadable, resolveDesignType } from "./table/db-readable";
export { DEFAULT_DB_SPACE } from "./shared/consts";
export { TableMetadata } from "./table/table-metadata";
export { FieldMappingStrategy, DocumentFieldMapper } from "./strategies/field-mapping";
export type { TReadControls } from "./strategies/field-mapping";
export { RelationalFieldMapper } from "./strategies/relational-field-mapper";
export { IntegrityStrategy, NativeIntegrity } from "./strategies/integrity";
export { ApplicationIntegrity } from "./strategies/application-integrity";
export {
  DbError,
  CasExhaustedError,
  CasMismatchError,
  bucketTimeZoneUnavailable,
  isConflict,
  isRetryableDbError,
  aggregateFailure,
  aggregateExpressionsNotSupported,
} from "./db-error";
export type { DbErrorCode } from "./db-error";
export { DbEncryption } from "./encryption";
export type { TDbEncryptionOptions } from "./encryption";
export { assertGeoPoint, guardFilter, guardQuery, guardAggregate } from "./query/query-guards";
export { isGeoPointType, isGeoIndexableType } from "./table/table-metadata";
export type { TPathPresence } from "./shared/union-shape";
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
export { getDbFieldOp, separateFieldOps, separateCas, reconcileCas } from "./ops";
export type { TFieldOps } from "./ops";
export { isPlainObject, isEmptyObject, getPath, deletePath } from "./shared/object";
export { uniqueKeyTuple } from "./shared/keys";
// ── Since 0.1.143 ────────────────────────────────────────────────────────────
export { selfOrAncestor } from "./shared/object";
export {
  searchIndexNotFoundMessage,
  vectorIndexNotFoundMessage,
  geoIndexNotFoundMessage,
} from "./shared/index-messages";

// ── Since 0.1.150 ────────────────────────────────────────────────────────────
export {
  INTEGER_REGEX_OP,
  searchTermInteger,
  splitFulltextFields,
  describeFulltext,
  defaultFulltextIndex,
} from "./shared/search-term";
export { searchMemberKind } from "./shared/search-fields";
export type { TSearchMemberKind } from "./shared/search-fields";

export type { DbResponse } from "./table/db-readable";
export { AtscriptDbTable } from "./table/db-table";
export { AtscriptDbView, isAtscriptDbView, isViewType } from "./table/db-view";
export type { TViewColumnMapping, TViewJsonType } from "./table/db-view";
// ── Since 0.1.153: view read pruning ─────────────────────────────────────────
export type { TViewReadPlan } from "./table/view-read-plan";
export { queryReadColumns } from "./query/read-columns";
export type { TReadColumnsKind } from "./query/read-columns";
export { BaseDbAdapter, ALL_BUCKET_UNITS, ALL_VIEW_CAPABILITIES } from "./base-adapter";
export type { TViewCapability } from "./base-adapter";
export { isColumnTypeChanged } from "./schema/column-diff";
export { fkColumns } from "./schema/fk-diff";
export { ALL_AGGREGATE_FNS } from "./query/aggregate-fns";
export { DbSpace } from "./table/db-space";
export type { TAdapterFactory, TDbSpaceOptions } from "./table/db-space";
export { UniquSelect } from "./query/uniqu-select";
export type { TExprAggregate, TFirstLast, TRowOrderKey } from "./query/uniqu-select";
export { decomposePatch, assertNoVersionWrites } from "./patch/patch-decomposer";
export { isVersionExemptPatch } from "./patch/version-exempt";
export { translateQueryTree, isFieldRef, evaluateExpr } from "./query/query-tree";
export { tableNameOf } from "./rel/relation-helpers";
// ── Since 0.1.141 ────────────────────────────────────────────────────────────
export { aliasTargetOf } from "./table/view-source";
export { isDbEntityType } from "./table/db-entity";
export type {
  TViewPlan,
  TViewJoin,
  AtscriptQueryNode,
  AtscriptQueryFieldRef,
  AtscriptQueryComparison,
  AtscriptRef,
  AtscriptExprNode,
  AtscriptOrderItem,
} from "./query/query-tree";
export type {
  DbQuery,
  DbControls,
  FilterExpr,
  FieldOpsFor,
  NullsPlacement,
  UniqueryControls,
  Uniquery,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbInsertIgnoreResult,
  TDbInsertManyIgnoreResult,
  TDbInsertIgnoreSlot,
  TDbInsertIgnoreOptions,
  TInsertOptions,
  TDbUpdateResult,
  TDbUpdateOptions,
  TDbDeleteResult,
  TDbIndex,
  TDbIndexField,
  TDbDefaultValue,
  TIdDescriptor,
  TIdentification,
  TDbFieldMeta,
  TDerivedColumn,
  TDerivedChangeReason,
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
  TDbAvailableActions,
  TDbActionTargetSummary,
  TDbActionLevel,
  TDbActionIntent,
  TDbActionProcessor,
  TCrudOp,
  TCrudPermissions,
  TExistingColumn,
  TExistingTableOption,
  TColumnDiff,
  TJsonCopyTarget,
  TTableOptionDiff,
  TSyncColumnResult,
  // Schema sync primitives (since 0.1.128)
  TPrimaryKeyChange,
  TExistingForeignKey,
  TReferencingForeignKey,
  TDbObjectKind,
  TEnsureTableOptions,
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
  DbPatch,
  DbRow,
  TDbWriteAction,
  TDbWriteGuardContext,
  TDbRemoveGuardContext,
  TDbWriteGuard,
  TDbWriteCheck,
  TDbWriteCheckContext,
  TDbRemoveGuard,
  TWriteOptions,
  TDeleteOptions,
  TIdResolveOptions,
  TRowResolveOptions,
  TTouchManyOptions,
} from "./types";
export type { TGenericLogger } from "./logger";
export { NoopLogger } from "./logger";
export { createFailureCollector } from "./shared/failure-collector";

// Re-export walker utilities from @uniqu/core for adapter implementations
export { walkFilter, isPrimitive, computeInsights } from "@uniqu/core";
export type { FilterVisitor } from "@uniqu/core";

// ── Relational filter predicates ($some / $none, since 0.1.147) ─────────────
export { isRelationOp, RELATION_OPS } from "@uniqu/core";
export type { RelationOp } from "@uniqu/core";
export {
  ResolvedRelationFilter,
  isResolvedRelationFilter,
  containsRelationFilter,
  forEachResolvedRelation,
  hasRelationOp,
  relationStaticFilter,
  andFilters,
  REL_FILTER_MAX_DEPTH,
  REL_FILTER_MAX_NODES,
} from "./query/relation-filter";
export type {
  TRelationFilterTable,
  TRelationFilterJunction,
  TRelationStaticFilter,
} from "./query/relation-filter";

// ── Query path guard + nullable typing (since 0.1.128) ──────────────────────
export {
  guardPath,
  guardPaths,
  sortFieldNames,
  collectQueryPaths,
  classifyQueryPath,
  checkHavingKeys,
  unsupportedOperatorMessage,
  canFilterLeaf,
  narrowerFilterOps,
  acceptedOperatorsHint,
  bucketSourceVerdict,
  groupSourceVerdict,
  ADAPTER_FILTER_REASON,
  ENCRYPTED_REASON,
} from "./query/query-guards";
export type {
  TQueryPathOp,
  TGuardedQuery,
  TQueryPathRefs,
  TFilterPredicate,
  TFilterRef,
  TQueryPathKind,
  TQueryPathSource,
  TBucketSourceVerdict,
  TBucketSourceTable,
  TGroupSourceVerdict,
} from "./query/query-guards";
export { findAncestorInSet } from "./table/table-metadata";

// ── Calendar buckets (since 0.1.132) ─────────────────────────────────────────
export {
  normalizeComputedSelect,
  resolveCalendarBuckets,
  isBucketableField,
  isJsonValueField,
  jsonValueAncestor,
} from "./query/buckets";
export type { TResolvedBucket, TBucketFieldSource } from "./query/buckets";
export { numericOperandProblem } from "./query/aggregate-expr";
export type {
  BucketExpr,
  BucketUnit,
  WeekStart,
  CalendarBucketLabel,
  ComputedExpr,
  ResolvedBucket,
} from "./agg";
export type { NullableOptional } from "./types";
