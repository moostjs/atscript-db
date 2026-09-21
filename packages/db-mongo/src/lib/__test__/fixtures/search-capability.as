// Text vs vector capability. MongoDB reaches text search two ways — the
// portable `@db.index.fulltext` (classic `$text`) and Atlas `@db.mongo.search.*`
// — and both land in the same index map as a vector index does.

@db.table 'cap_text'
@db.mongo.collection
export interface CapText {
    @meta.id
    _id: string

    @db.index.fulltext 'cap_text_fts'
    title: string
}

@db.table 'cap_atlas'
@db.mongo.collection
@db.mongo.search.dynamic 'lucene.standard'
export interface CapAtlas {
    @meta.id
    _id: string

    title: string
}

@db.table 'cap_vector'
@db.mongo.collection
export interface CapVector {
    @meta.id
    _id: string

    title: string

    @db.search.vector 512, "cosine"
    embedding: number[]
}

@db.table 'cap_both'
@db.mongo.collection
export interface CapBoth {
    @meta.id
    _id: string

    @db.index.fulltext 'cap_both_fts'
    title: string

    @db.search.vector 512, "cosine"
    embedding: number[]
}
