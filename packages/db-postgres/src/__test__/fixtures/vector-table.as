@db.table 'articles'
export interface ArticlesTable {
    @meta.id
    id: string

    title: string

    @db.search.vector 1536, "cosine"
    embedding: number[]
}
