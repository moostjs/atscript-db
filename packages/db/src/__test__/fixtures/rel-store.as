// `@db.rel.store`: navigations without foreign keys, correlated by the store
// (an adapter whose `supportsWithInRead()` is true).

@db.table 'rs_shelves'
@db.depth.limit 2
export interface RsShelf {
    @meta.id
    id: number

    label: string

    @db.rel.from
    books: RsBook[]

    @db.rel.store
    @db.rel.filterable
    featured: RsBook[]

    @db.rel.store
    curator?: RsPerson
}

@db.table 'rs_books'
export interface RsBook {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    shelfId?: RsShelf.id

    @db.rel.to
    shelf?: RsShelf

    @db.rel.store
    @db.rel.filter `RsNote.id < 11`
    notes: RsNote[]
}

@db.table 'rs_notes'
export interface RsNote {
    @meta.id
    id: number

    text: string
}

@db.table 'rs_people'
export interface RsPerson {
    @meta.id
    id: number

    name: string
}
