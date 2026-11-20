// Fixture for vector-read.spec.ts (since 0.1.178): a SQLite vector read over HTTP.

@db.table 'vr_docs'
export interface VrDoc {
    @meta.id
    id: number

    title: string

    @db.search.vector 3, "cosine"
    embedding?: number[]
}
