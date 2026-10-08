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
