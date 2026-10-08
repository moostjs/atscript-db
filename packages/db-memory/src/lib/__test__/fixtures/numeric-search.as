// `@db.column.searchable` on integer fields (numeric-search.spec.ts). Since 0.1.150.

@db.table 'ns_fallback'
export interface NsFallback {
    @meta.id
    id: number.int

    @db.column.searchable
    title: string

    @db.column.searchable
    ref_no: number.int
}
