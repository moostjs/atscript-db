// Before/after pairs for schema-sync edge cases. V1 = initial state,
// V2 = evolved state syncing over it (same table names).

// ── Composite index membership change (same index name, column joins) ──

@db.table 'uc_imc'
export interface UcImcV1 {
    @meta.id
    @db.default.increment
    id: number

    @db.index.plain 'uc_imc_idx'
    region: string

    status: string
}

@db.table 'uc_imc'
export interface UcImcV2 {
    @meta.id
    @db.default.increment
    id: number

    @db.index.plain 'uc_imc_idx'
    region: string

    @db.index.plain 'uc_imc_idx'
    status: string
}

// ── Unique index added over duplicate data ──

@db.table 'uc_uod'
export interface UcUodV1 {
    @meta.id
    @db.default.increment
    id: number

    email: string
}

@db.table 'uc_uod'
export interface UcUodV2 {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'uc_uniq_email'
    email: string
}

// ── Dropping a column referenced by a tracked view ──

@db.table 'uc_articles'
export interface UcArticleV1 {
    @meta.id
    @db.default.increment
    id: number

    title: string

    summary?: string
}

@db.view 'uc_article_list'
@db.view.for UcArticleV1
export interface UcListV1 {
    id: UcArticleV1.id
    title: UcArticleV1.title
    summary?: UcArticleV1.summary
}

@db.table 'uc_articles'
export interface UcArticleV2 {
    @meta.id
    @db.default.increment
    id: number

    title: string
}

@db.view 'uc_article_list'
@db.view.for UcArticleV2
export interface UcListV2 {
    id: UcArticleV2.id
    title: UcArticleV2.title
}

// ── Dropping a fulltext-indexed column (FTS5 artifacts must go first) ──

@db.table 'uc_docs'
export interface UcDocV1 {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.index.fulltext 'uc_ft'
    content?: string
}

@db.table 'uc_docs'
export interface UcDocV2 {
    @meta.id
    @db.default.increment
    id: number

    title: string
}
