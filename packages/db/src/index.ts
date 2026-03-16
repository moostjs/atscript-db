export { AtscriptDbReadable, resolveDesignType } from "./table/db-readable";
export { TableMetadata } from "./table/table-metadata";
export { FieldMappingStrategy, DocumentFieldMapper } from "./strategies/field-mapping";
export { RelationalFieldMapper } from "./strategies/relational-field-mapper";
export { IntegrityStrategy, NativeIntegrity } from "./strategies/integrity";
export { ApplicationIntegrity } from "./strategies/application-integrity";
export { DbError } from "./db-error";
export type { DbErrorCode } from "./db-error";
export { createDbValidatorPlugin } from "./db-validator-plugin";
export type { DbValidationContext } from "./db-validator-plugin";
export type { DbResponse } from "./table/db-readable";
export { AtscriptDbTable } from "./table/db-table";
export { AtscriptDbView } from "./table/db-view";
export type { TViewColumnMapping } from "./table/db-view";
export { BaseDbAdapter } from "./base-adapter";
export { DbSpace } from "./table/db-space";
export type { TAdapterFactory } from "./table/db-space";
export { UniquSelect } from "./query/uniqu-select";
export { decomposePatch } from "./patch/patch-decomposer";
export { getKeyProps } from "./patch/patch-types";
export { translateQueryTree } from "./query/query-tree";
export type {
  TViewPlan,
  TViewJoin,
  AtscriptQueryNode,
  AtscriptQueryFieldRef,
  AtscriptQueryComparison,
  AtscriptRef,
} from "./query/query-tree";

export type { TArrayPatch, TDbPatch } from "./patch/patch-types";
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

// Re-export walker utilities from @uniqu/core for adapter implementations
export { walkFilter, isPrimitive, computeInsights } from "@uniqu/core";
export type { FilterVisitor } from "@uniqu/core";
