// `@normalize.*` on writes (normalize-writes.spec.ts). Since 0.1.170.

@normalize.trim
@normalize.lowercase
export type NwLabel = string

@db.table 'nw_users'
@db.depth.limit 2
export interface NwUser {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'nw_user_email_idx'
    @normalize.trim
    @normalize.lowercase
    @expect.pattern '^[a-z0-9@.]+$'
    email: string

    @normalize.trim
    name: string

    @normalize.uppercase
    code?: string

    labels?: NwLabel[]

    @db.patch.strategy 'merge'
    profile?: {
        @normalize.trim
        city?: string
    }

    @db.patch.strategy 'merge'
    contacts?: {
        @expect.array.key
        kind: NwLabel
        @normalize.trim
        value?: string
    }[]

    @db.rel.from 'owner'
    notes?: NwNote[]

    @db.rel.via NwUserTag
    tags?: NwTag[]
}

@db.table 'nw_notes'
export interface NwNote {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'owner'
    ownerId?: NwUser.id

    @db.rel.to 'owner'
    owner?: NwUser

    @normalize.trim
    title: string
}

@db.table 'nw_tags'
export interface NwTag {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'nw_tag_name_idx'
    name: NwLabel
}

@db.table 'nw_user_tags'
export interface NwUserTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    userId: NwUser.id

    @db.rel.FK
    tagId: NwTag.id
}

// A versioned table keyed by a normalized code (touchMany keys).
@db.table 'nw_codes'
export interface NwCode {
    @meta.id
    code: NwLabel

    label: string

    @db.column.version
    version: number.int
}
