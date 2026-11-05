// Nested writes two and three levels deep: the checks of every level run
// before the root writes anything.
@db.table 'dn_roots'
@db.depth.limit 4
export interface DnRoot {
    @meta.id
    @db.default.increment
    id: number

    label: string

    @db.rel.from 'root'
    mids?: DnMid[]
}

@db.table 'dn_mids'
@db.depth.limit 4
export interface DnMid {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'root'
    rootId?: DnRoot.id

    note: string

    // Linked by an OPTIONAL unique field: a nested object without it cannot be linked.
    @db.rel.FK 'slugged'
    sluggedSlug?: DnSlugged.slug

    @db.rel.to 'slugged'
    slugged?: DnSlugged

    @db.rel.from 'mid'
    leaves?: DnLeaf[]

    @db.rel.via DnMidTag
    tags?: DnTag[]
}

@db.table 'dn_slugged'
export interface DnSlugged {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'dn_slug_idx'
    slug?: string

    label: string
}

@db.table 'dn_leaves'
@db.depth.limit 4
export interface DnLeaf {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'mid'
    midId?: DnMid.id

    @db.rel.FK
    tagId?: DnTag.id

    note: string

    @db.rel.from 'leaf'
    twigs?: DnTwig[]
}

@db.table 'dn_twigs'
@db.depth.limit 4
export interface DnTwig {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'leaf'
    leafId?: DnLeaf.id

    @db.rel.FK 'slugged'
    sluggedSlug?: DnSlugged.slug

    @db.rel.to 'slugged'
    slugged?: DnSlugged

    note: string
}

@db.table 'dn_tags'
export interface DnTag {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'dn_tag_name_idx'
    name: string
}

@db.table 'dn_mid_tags'
export interface DnMidTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    midId: DnMid.id

    @db.rel.FK
    tagId: DnTag.id
}
