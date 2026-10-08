// Integer members of fulltext indexes (numeric-search*.spec.ts). Since 0.1.150.

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

@db.table 'ns_atlas'
@db.mongo.collection
@db.mongo.search.static 'lucene.standard', 0, 'ns_atlas'
export interface NsAtlas {
    @meta.id
    _id: string

    @db.mongo.search.text 'lucene.standard', 'ns_atlas'
    title: string

    @db.index.fulltext 'ns_atlas_ft'
    @db.index.plain
    ref_no: number.int
}

@db.table 'ns_atlas_dynamic'
@db.mongo.collection
@db.mongo.search.dynamic 'lucene.standard'
export interface NsAtlasDynamic {
    @meta.id
    _id: string

    title: string

    @db.index.fulltext 'ns_dyn_ft'
    @db.index.plain
    ref_no: number.int
}

@db.table 'ns_fallback'
export interface NsFallback {
    @meta.id
    id: number.int

    @db.column.searchable
    title: string

    @db.column.searchable
    ref_no: number.int
}

// Two fulltext indexes: text 'ns_main' + an integer-only 'ns_ids' (per-index integer members).
@db.table 'ns_two_idx'
export interface NsTwoIdx {
    @meta.id
    id: number.int

    @db.index.fulltext 'ns_main'
    title: string

    @db.index.fulltext 'ns_ids'
    @db.index.unique
    internal_no: number.int
}

// The integer-only index is declared FIRST: the default is still the text one.
@db.table 'ns_ids_first'
export interface NsIdsFirst {
    @meta.id
    id: number.int

    @db.index.fulltext 'ns_ids2'
    @db.index.unique
    internal_no: number.int

    @db.index.fulltext 'ns_main2'
    title: string
}

@db.table 'ns_two_text'
export interface NsTwoText {
    @meta.id
    id: number.int

    @db.index.fulltext 'main_ft'
    notes: string

    @db.index.fulltext 'alt_ft'
    title: string
}

@db.table 'ns_text_plus_int'
export interface NsTextPlusInt {
    @meta.id
    id: number.int

    @db.index.fulltext 'main_ft'
    notes: string

    @db.index.fulltext 'int_ft'
    @db.index.plain
    ref_no: number.int
}
