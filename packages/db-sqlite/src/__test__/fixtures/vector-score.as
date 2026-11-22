// Fixture for vector-score.spec.ts (since 0.1.183): `$score` on every vector
// row, one table per similarity metric.

@db.table 'vs_cos'
export interface VsCos {
    @meta.id
    id: string

    title: string

    @db.search.vector 2, "cosine"
    embedding: number[]
}

@db.table 'vs_l2'
export interface VsL2 {
    @meta.id
    id: string

    title: string

    @db.search.vector 2, "euclidean"
    embedding: number[]
}

@db.table 'vs_dot'
export interface VsDot {
    @meta.id
    id: string

    title: string

    @db.search.vector 2, "dotProduct"
    embedding: number[]
}

@db.table 'vs_schema'
export interface VsSchema {
    @meta.id
    id: string

    title: string

    @db.search.vector 2, "euclidean"
    @db.search.vector.threshold 0.3
    embedding: number[]
}

// since 0.1.184: fields named like the engine-specific result fields of
// earlier versions are ordinary stored columns
@db.table 'vs_stored'
export interface VsStored {
    @meta.id
    id: string

    title: string

    _distance: number

    _score: number

    @db.search.vector 2, "cosine"
    embedding: number[]
}
