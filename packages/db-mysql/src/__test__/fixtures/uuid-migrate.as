// uuid keys migrating from the earlier VARCHAR(255) to CHAR(36)
// (uuid-keys.live.spec.ts). The *Old models are the earlier layout, kept with
// @db.mysql.type; the others the current one, under the same table names.

@db.table 'um_parents'
export interface UmParentOld {
    @meta.id
    @db.default.uuid
    @db.mysql.type 'VARCHAR(255)'
    id: string

    @db.default.uuid
    @db.mysql.type 'VARCHAR(255)'
    @db.index.unique 'um_pair_idx'
    pairA: string

    @db.default.uuid
    @db.mysql.type 'VARCHAR(255)'
    @db.index.unique 'um_pair_idx'
    pairB: string

    name: string
}

@db.table 'um_children'
export interface UmChildOld {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'parent'
    @db.rel.onDelete 'cascade'
    parentId: UmParentOld.id

    @db.rel.FK 'pair'
    pairA?: UmParentOld.pairA

    @db.rel.FK 'pair'
    pairB?: UmParentOld.pairB

    note: string
}

@db.table 'um_tags'
export interface UmTagOld {
    @meta.id
    @db.default.uuid
    @db.mysql.type 'VARCHAR(255)'
    id: string

    name: string
}

@db.table 'um_links'
export interface UmLinkOld {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    @db.rel.onUpdate 'cascade'
    parentId: UmParentOld.id

    @db.rel.FK
    tagId: UmTagOld.id
}

@db.table 'um_nodes'
export interface UmNodeOld {
    @meta.id
    @db.default.uuid
    @db.mysql.type 'VARCHAR(255)'
    id: string

    @db.rel.FK
    parentId?: UmNodeOld.id

    name: string
}

@db.table 'um_parents'
export interface UmParent {
    @meta.id
    @db.default.uuid
    id: string

    @db.default.uuid
    @db.index.unique 'um_pair_idx'
    pairA: string

    @db.default.uuid
    @db.index.unique 'um_pair_idx'
    pairB: string

    name: string
}

@db.table 'um_children'
export interface UmChild {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'parent'
    @db.rel.onDelete 'cascade'
    parentId: UmParent.id

    @db.rel.FK 'pair'
    pairA?: UmParent.pairA

    @db.rel.FK 'pair'
    pairB?: UmParent.pairB

    note: string
}

@db.table 'um_tags'
export interface UmTag {
    @meta.id
    @db.default.uuid
    id: string

    name: string
}

@db.table 'um_links'
export interface UmLink {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    @db.rel.onUpdate 'cascade'
    parentId: UmParent.id

    @db.rel.FK
    tagId: UmTag.id
}

@db.table 'um_nodes'
export interface UmNode {
    @meta.id
    @db.default.uuid
    id: string

    @db.rel.FK
    parentId?: UmNode.id

    name: string
}
