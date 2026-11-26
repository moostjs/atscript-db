// Relations read inside the root read (adapter `supportsWithInRead()`).

@db.table 'wr_authors'
export interface WrAuthor {
    @meta.id
    id: number

    name: string

    @db.rel.from
    @db.rel.filter `WrBook.status = 'published'`
    books: WrBook[]
}

@db.table 'wr_books'
export interface WrBook {
    @meta.id
    id: number

    title: string

    status: string

    @db.column 'in_print'
    inPrint: boolean

    @db.rel.FK
    authorId: WrAuthor.id

    @db.rel.to
    author?: WrAuthor

    @db.rel.from
    chapters: WrChapter[]
}

@db.table 'wr_chapters'
export interface WrChapter {
    @meta.id
    id: number

    title: string

    pages: number

    @db.rel.FK
    bookId: WrBook.id

    @db.rel.to
    book?: WrBook
}

@db.table 'wr_tags'
export interface WrTag {
    @meta.id
    id: number

    label: string
}

@db.table 'wr_tagged'
export interface WrTagged {
    @meta.id
    id: number

    @db.rel.via WrTaggedTag
    tags: WrTag[]
}

@db.table 'wr_tagged_tags'
export interface WrTaggedTag {
    @meta.id
    id: number

    @db.rel.FK
    taggedId: WrTagged.id

    @db.rel.FK
    tagId: WrTag.id
}

// The foreign key's column is named like the navigation field.
@db.table 'wr_reviews'
export interface WrReview {
    @meta.id
    id: number

    @db.rel.FK
    @db.column 'book'
    bookRef: WrBook.id

    @db.rel.to
    book?: WrBook
}
