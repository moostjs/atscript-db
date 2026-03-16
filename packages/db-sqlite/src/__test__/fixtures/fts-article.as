@db.table 'articles'
export interface Article {
    @meta.id
    @db.default.increment
    id: number

    @db.index.fulltext 'articles_ft'
    title: string

    @db.index.fulltext 'articles_ft'
    body: string

    category: string
}
