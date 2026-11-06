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

    // a default a nested row gets: normalized and validated like a direct insert's
    @db.default 'NEW'
    @normalize.lowercase
    @expect.pattern '^[a-z]+$'
    status?: string
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

// An object union without a discriminator: only the first member normalizes.
export interface NwEmailContact {
    @normalize.lowercase
    value: string

    note?: string
}

export interface NwPhoneContact {
    value: string

    ext: string
}

@db.table 'nw_contacts'
export interface NwContact {
    @meta.id
    id: number

    contact?: NwEmailContact | NwPhoneContact
}

// A composite primary key with a normalized part (id lookups).
@db.table 'nw_pairs'
export interface NwPair {
    @meta.id
    tenant: NwLabel

    @meta.id
    num: number

    label: string
}

// Keyed by a normalized code that rows stored before the code was normalized
// hold as written ("ABC"): relation filters built from stored values compare
// them as stored.
@db.table 'nw_groups'
export interface NwGroup {
    @meta.id
    code: NwLabel

    @db.index.unique 'nw_group_name_idx'
    name: string

    @db.rel.from
    members?: NwMember[]
}

@db.table 'nw_members'
export interface NwMember {
    @meta.id
    id: number

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    groupCode: NwGroup.code

    @db.rel.to
    group?: NwGroup
}
