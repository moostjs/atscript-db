// uuid-defaulted strings are CHAR(36) (uuid-keys.spec.ts,
// uuid-keys.live.spec.ts): as a primary key, a referenced key or a plain
// column; the foreign-key columns pointing at them take the same type.

@db.table 'uk_parents'
export interface UkParent {
    @meta.id
    @db.default.uuid
    id: string

    // A plain uuid column
    @db.default.uuid
    token: string

    // A declared length wins
    @db.default.uuid
    @expect.maxLength 64
    sized: string

    // Another default keeps VARCHAR(255)
    @db.default 'draft'
    status: string

    // A composite unique key of uuid columns
    @db.default.uuid
    @db.index.unique 'uk_pair_idx'
    pairA: string

    @db.default.uuid
    @db.index.unique 'uk_pair_idx'
    pairB: string

    label: string

    @db.rel.via UkLink
    tags?: UkTag[]
}

@db.table 'uk_children'
export interface UkChild {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'parent'
    parentId: UkParent.id

    @db.rel.FK 'pair'
    pairA?: UkParent.pairA

    @db.rel.FK 'pair'
    pairB?: UkParent.pairB

    note: string
}

@db.table 'uk_tags'
export interface UkTag {
    @meta.id
    @db.default.uuid
    id: string

    name: string
}

@db.table 'uk_links'
export interface UkLink {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    parentId: UkParent.id

    @db.rel.FK
    tagId: UkTag.id
}

// A uuid tree: the self-reference takes CHAR(36) too
@db.table 'uk_nodes'
export interface UkNode {
    @meta.id
    @db.default.uuid
    id: string

    @db.rel.FK
    parentId?: UkNode.id

    name: string
}

// The earlier layout kept with an explicit type
@db.table 'uk_legacy'
export interface UkLegacy {
    @meta.id
    @db.default.uuid
    @db.mysql.type 'VARCHAR(255)'
    id: string

    name: string
}

@db.table 'uk_legacy_refs'
export interface UkLegacyRef {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    legacyId: UkLegacy.id
}

// An integer key (fk-lift compatibility, uuid-keys.spec.ts)
@db.table 'uk_counters'
export interface UkCounter {
    @meta.id
    id: number.int.int64

    name: string
}
