// Integer members of fulltext indexes (numeric-search.spec.ts). Since 0.1.150.

@db.table 'ns_items'
export interface NsItem {
    @meta.id
    id: number.int

    @db.index.fulltext 'ns_ft'
    title: string

    @db.index.fulltext 'ns_ft'
    @db.index.plain
    ref_no: number.int

    @db.index.fulltext 'ns_ft'
    @db.index.unique
    alt_no?: number.int
}

@db.table 'ns_codes'
export interface NsCode {
    @meta.id
    @db.index.fulltext 'ns_codes_ft'
    id: number.int

    label: string
}
