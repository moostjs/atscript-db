// Numeric search members (numeric-search-runtime.spec.ts, integer-regex.spec.ts). Since 0.1.150.

@db.table 'nsr_fallback'
export interface NsrFallback {
    @meta.id
    id: number.int

    @db.column.searchable
    title: string

    @db.column.searchable
    refNo: number.int

    @db.column.searchable
    @expect.int
    tag: number

    amount: number
}

@db.table 'nsr_native'
export interface NsrNative {
    @meta.id
    id: number.int

    @db.index.fulltext 'nsr_ft'
    title: string

    @db.index.fulltext 'nsr_ft'
    @db.index.plain
    refNo: number.int

    @db.index.fulltext 'nsr_ft'
    @db.index.unique
    altRefNo?: number.int
}

@db.table 'nsr_codes'
export interface NsrCode {
    @meta.id
    @db.index.fulltext 'nsr_codes_ft'
    id: number.int

    label: string
}
