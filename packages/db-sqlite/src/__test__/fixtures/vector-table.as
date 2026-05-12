@db.table 'documents'
@db.depth.limit 0
export interface Document {
    @meta.id
    id: string

    title: string

    @db.search.vector 512, "cosine"
    embedding: number[]
}

@db.table 'articles'
@db.depth.limit 0
export interface Article {
    @meta.id
    id: string

    @db.search.filter "embedding"
    category: string

    @db.search.filter "embedding"
    status: string

    score: number

    @db.search.vector 512, "cosine"
    @db.search.vector.threshold 0.5
    embedding: number[]
}

@db.table 'points'
@db.depth.limit 0
export interface Point {
    @meta.id
    id: string

    @db.search.vector 512, "euclidean"
    embedding: number[]
}

@db.table 'renamed_docs'
@db.depth.limit 0
export interface RenamedDoc {
    @meta.id
    id: string

    @db.column 'emb_vec'
    @db.search.vector 512, "cosine"
    embedding: number[]
}

@db.table 'no_vector'
@db.depth.limit 0
export interface NoVector {
    @meta.id
    id: string

    name: string
}
