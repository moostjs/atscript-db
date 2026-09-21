@db.table 'cap_text'
@db.depth.limit 0
export interface CapText {
    @meta.id
    id: string

    @db.index.fulltext 'cap_text_ft'
    title: string
}

@db.table 'cap_vector'
@db.depth.limit 0
export interface CapVector {
    @meta.id
    id: string

    title: string

    @db.search.vector 512, "cosine"
    embedding: number[]
}

@db.table 'cap_both'
@db.depth.limit 0
export interface CapBoth {
    @meta.id
    id: string

    @db.index.fulltext 'cap_both_ft'
    title: string

    @db.search.vector 512, "cosine"
    embedding: number[]
}
