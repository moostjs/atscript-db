// Keys under a case-insensitive collation: the database treats "tag" and
// "TAG" as one value — nested writes must match stored rows the same way.
@db.table 'nc_tags'
export interface NcTag {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'nc_tag_name_idx'
    @db.column.collate 'nocase'
    name: string
}

// Junction keyed by the tag's unique name.
@db.table 'nc_post_tags'
export interface NcPostTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    postId: NcPost.id

    @db.rel.FK
    tagName: NcTag.name
}

@db.table 'nc_codes'
export interface NcCode {
    @meta.id
    @db.column.collate 'nocase'
    code: string

    label?: string
}

@db.table 'nc_post_codes'
export interface NcPostCode {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    postId: NcPost.id

    @db.rel.FK
    code: NcCode.code
}

@db.table 'nc_posts'
@db.depth.limit 2
export interface NcPost {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.via NcPostTag
    tags?: NcTag[]

    @db.rel.via NcPostCode
    codes?: NcCode[]

    @db.rel.from
    notes?: NcNote[]
}

// FROM children keyed by a case-insensitive string.
@db.table 'nc_notes'
export interface NcNote {
    @meta.id
    @db.column.collate 'nocase'
    key: string

    @db.rel.FK
    postId?: NcPost.id

    body: string
}

// A TO relation by the tag's case-insensitive unique name.
@db.table 'nc_comments'
export interface NcComment {
    @meta.id
    id: number

    @db.rel.FK 'tag'
    tagName?: NcTag.name

    @db.rel.to 'tag'
    tag?: NcTag

    body: string
}
