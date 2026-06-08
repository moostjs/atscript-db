// Fulltext-only table: its only text-search declaration is the portable
// `@db.index.fulltext`, which syncs to a CLASSIC MongoDB text index. search()
// must execute via classic `$text`, NOT Atlas `$search`.
@db.table 'articles'
@db.mongo.collection
export interface Article {
    @meta.id
    @db.default.increment
    id: number

    @db.index.fulltext 'articles_fts'
    title: string

    @db.index.fulltext 'articles_fts'
    body: string

    category: string
}

// Atlas dynamic search table: search() must execute via Atlas `$search`.
@db.table 'docs'
@db.mongo.collection
@db.mongo.search.dynamic 'lucene.standard'
export interface SearchDoc {
    @meta.id
    _id: string

    title: string
}
