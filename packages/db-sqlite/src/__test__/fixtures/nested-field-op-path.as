// Fixture for nested-field-op-path.spec.ts (since 0.1.184): a field operator
// inside a replace-strategy object of a related row.

@db.table 'nfo_authors'
@db.depth.limit 2
export interface NfoAuthor {
    @meta.id
    id: number

    obj?: {
        n: number
    }

    @db.rel.from
    posts?: NfoPost[]
}

@db.table 'nfo_posts'
@db.depth.limit 2
export interface NfoPost {
    @meta.id
    id: number

    obj?: {
        n: number
    }

    @db.rel.FK
    authorId?: NfoAuthor.id

    @db.rel.to
    au?: NfoAuthor
}
