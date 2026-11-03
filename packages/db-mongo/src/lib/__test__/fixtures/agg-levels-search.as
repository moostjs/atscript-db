// A two-level aggregate under a root `$search` (MongoDB `$text`) —
// aggregate-levels-search-server.spec.ts. Since 0.1.168.

@db.table 'al_articles'
export interface AlArticle {
    @meta.id
    id: number

    @db.index.fulltext 'al_articles_ft'
    title: string

    category: string
}
