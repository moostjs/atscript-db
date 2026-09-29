// Readable seams for permission layers (since 0.1.143): `jsonParents` and
// `foreignKeyOf(relation)`.

@db.table 'rs_orgs'
export interface RsOrg {
    @meta.id
    id: number

    name: string
}

@db.table 'rs_users'
export interface RsUser {
    @meta.id
    id: number

    name: string
}

@db.table 'rs_docs'
export interface RsDoc {
    @meta.id
    id: number

    @db.json
    settings: {
        theme: string
        size: number
    }

    profile: {
        city: string
        zip: string
    }

    tags: string[]

    @db.rel.FK
    orgId?: RsOrg.id

    @db.rel.to
    org?: RsOrg

    @db.rel.FK 'author'
    authorId?: RsUser.id

    @db.rel.to 'author'
    author?: RsUser

    @db.rel.FK 'reviewer'
    reviewerId?: RsUser.id

    @db.rel.to 'reviewer'
    reviewer?: RsUser

    @db.rel.from
    comments?: RsComment[]
}

@db.table 'rs_comments'
export interface RsComment {
    @meta.id
    id: number

    body: string

    @db.rel.FK
    docId?: RsDoc.id

    @db.rel.to
    doc?: RsDoc
}
