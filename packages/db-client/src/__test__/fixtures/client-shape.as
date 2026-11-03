// Generated models used as `Client<typeof X>` type arguments (client-shape.spec.ts).

@db.table 'cs_authors'
export interface CsAuthor {
    @meta.id
    id: number

    name: string

    @db.rel.from
    posts: CsPost[]
}

@db.table 'cs_posts'
export interface CsPost {
    @meta.id
    id: number

    title: string

    tags: string[]

    views: number

    @db.rel.FK
    authorId: CsAuthor.id

    @db.rel.to
    author?: CsAuthor
}

@db.table 'cs_featured'
export interface CsFeatured extends CsPost {
    rank: number
}

export interface CsPlain {
    a: string
}
