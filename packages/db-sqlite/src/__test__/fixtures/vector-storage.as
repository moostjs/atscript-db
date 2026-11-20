// Fixtures for vector-storage.spec.ts (since 0.1.178): SQLite stores a vector
// as a Float32 BLOB with sqlite-vec; rows from before hold JSON text.

@db.table 'vs_docs'
@db.depth.limit 0
export interface VsDoc {
    @meta.id
    id: string

    title: string

    @db.search.vector 4, "cosine"
    embedding?: number[]
}

@db.table 'vs_renamed'
@db.depth.limit 0
export interface VsRenamed {
    @meta.id
    id: string

    @db.column 'emb_col'
    @db.search.vector 4, "cosine"
    embedding?: number[]
}

@db.view 'vs_doc_view'
@db.view.for VsDoc
export interface VsDocView {
    id: VsDoc.id
    title: VsDoc.title
    embedding: VsDoc.embedding
}

// The same table with the vector annotation removed: its column may still
// hold Float32 BLOBs written before.
@db.table 'vs_docs'
@db.depth.limit 0
export interface VsDocPlain {
    @meta.id
    id: string

    title: string

    embedding?: number[]
}

// A vector inside a flattened nested object: column `info__embedding`.
@db.table 'vs_nested'
@db.depth.limit 0
export interface VsNested {
    @meta.id
    id: string

    info: {
        label: string

        @db.search.vector 4, "cosine"
        embedding?: number[]
    }
}
