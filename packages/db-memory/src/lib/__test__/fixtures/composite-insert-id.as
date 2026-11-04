// Inserted ids of composite primary keys (composite-insert-id.spec.ts). Since 0.1.169.

@db.table 'cid_pairs'
@db.depth.limit 2
export interface CidPair {
    @meta.id
    left: number

    @meta.id
    @db.column 'right_key'
    right: string

    @db.index.unique 'cid_code_idx'
    code?: number

    label: string

    @db.rel.from 'pair'
    links?: CidLink[]
}

@db.table 'cid_single'
export interface CidSingle {
    @meta.id
    @db.default.increment
    id: number

    label: string
}

@db.table 'cid_seq'
export interface CidSeq {
    @meta.id
    tenant: string

    @meta.id
    @db.default.increment
    seq: number

    label: string
}

@db.table 'cid_codes'
@db.depth.limit 2
export interface CidCoded {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'cid_coded_code_idx'
    code: string

    label: string

    @db.rel.from 'coded'
    links?: CidLink[]

    @db.rel.via CidCodedTag
    tags?: CidTag[]

    @db.rel.via CidCodedVt
    vts?: CidVTarget[]
}

@db.table 'cid_tags'
export interface CidTag {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'cid_tag_name_idx'
    name: string
}

// Junction keyed by the unique fields of both sides, not their ids.
@db.table 'cid_coded_tags'
export interface CidCodedTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    codedCode: CidCoded.code

    @db.rel.FK
    tagName: CidTag.name
}

@db.table 'cid_links'
@db.depth.limit 2
export interface CidLink {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'pair'
    pairLeft?: CidPair.left

    @db.rel.FK 'pair'
    pairRight?: CidPair.right

    @db.rel.to 'pair'
    pair?: CidPair

    @db.rel.FK 'coded'
    codedCode?: CidCoded.code

    @db.rel.to 'coded'
    coded?: CidCoded

    note: string
}

// A composite-key VIA target, linked by its unique `code`.
@db.table 'cid_vtargets'
export interface CidVTarget {
    @meta.id
    a: number

    @meta.id
    @db.default.increment
    b: number

    @db.index.unique 'cid_vt_code_idx'
    code: string
}

@db.table 'cid_coded_vts'
export interface CidCodedVt {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    codedCode: CidCoded.code

    @db.rel.FK
    vtCode: CidVTarget.code
}

// Referenced by a unique field the SDK defaults (`@db.default.uuid`).
@db.table 'cid_pubs'
@db.depth.limit 2
export interface CidPub {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'cid_pub_idx'
    @db.default.uuid
    pub: string

    label: string

    @db.rel.from 'pub'
    kids?: CidPubKid[]
}

@db.table 'cid_pub_kids'
@db.depth.limit 2
export interface CidPubKid {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'pub'
    parentPub?: CidPub.pub

    @db.rel.to 'pub'
    parent?: CidPub

    note: string
}

// A single string primary key.
@db.table 'cid_sparents'
@db.depth.limit 2
export interface CidSParent {
    @meta.id
    id: string

    label: string

    @db.rel.from 'sp'
    kids?: CidSKid[]
}

@db.table 'cid_skids'
export interface CidSKid {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'sp'
    spId?: CidSParent.id

    note: string
}

// Referenced by an OPTIONAL unique field: absent, the links cannot be resolved.
@db.table 'cid_slugged'
@db.depth.limit 2
export interface CidSlugged {
    @meta.id
    @db.default.increment
    id: number

    // Filled by the TO phase when the payload names a `slugOwner`.
    @db.index.unique 'cid_slug_idx'
    @db.rel.FK 'slugOwner'
    slug?: CidSlugOwner.slug

    @db.rel.to 'slugOwner'
    slugOwner?: CidSlugOwner

    @db.rel.FK 'owner'
    ownerId?: CidSParent.id

    @db.rel.to 'owner'
    owner?: CidSParent

    label: string

    @db.rel.from 'slugged'
    kids?: CidSlugKid[]

    @db.rel.via CidSlugTag
    tags?: CidTag[]
}

@db.table 'cid_slug_kids'
@db.depth.limit 2
export interface CidSlugKid {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'slugged'
    sluggedSlug?: CidSlugged.slug

    @db.rel.to 'slugged'
    slugged?: CidSlugged

    note: string
}

@db.table 'cid_slug_tags'
export interface CidSlugTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    sluggedSlug: CidSlugged.slug

    @db.rel.FK
    tagId: CidTag.id
}

@db.table 'cid_slug_owners'
export interface CidSlugOwner {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'cid_slug_owner_idx'
    slug: string
}

// Referenced by a unique field the DATABASE side generates (`increment` is never SDK-filled).
@db.table 'cid_nos'
@db.depth.limit 2
export interface CidNo {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'cid_no_idx'
    @db.default.increment
    no?: number

    label: string
}

@db.table 'cid_no_kids'
@db.depth.limit 2
export interface CidNoKid {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'no'
    noRef?: CidNo.no

    @db.rel.to 'no'
    noRow?: CidNo

    note: string
}

// A parent addressed by a unique field in a patch.
@db.table 'cid_users'
@db.depth.limit 2
export interface CidUser {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'cid_user_email_idx'
    email: string

    label: string

    @db.rel.from 'u'
    kids?: CidUserKid[]

    @db.rel.via CidUserTag
    tags?: CidTag[]
}

@db.table 'cid_user_kids'
export interface CidUserKid {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'u'
    uId?: CidUser.id

    note: string
}

@db.table 'cid_user_tags'
export interface CidUserTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    uId: CidUser.id

    @db.rel.FK
    tagId: CidTag.id
}
