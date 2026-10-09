// Nested FROM replace across several parents: the current children of every
// parent are read once (since 0.1.151); writes stay per parent.

@db.table 'nb_parents'
@db.depth.limit 2
export interface NbParent {
    @meta.id
    id: number

    name?: string

    @db.rel.from
    children?: NbChild[]
}

@db.table 'nb_children'
export interface NbChild {
    @meta.id
    @db.default.increment
    id: number

    label?: string

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    parentId?: NbParent.id

    @db.rel.to
    parent?: NbParent
}

// Self-referencing tree: a child's own nested children may belong to a
// parent later in the same batch.
@db.table 'nb_nodes'
@db.depth.limit 3
export interface NbNode {
    @meta.id
    @db.default.increment
    id: number

    label?: string

    @db.rel.FK 'up'
    @db.rel.onDelete 'cascade'
    parentId?: NbNode.id

    @db.rel.to 'up'
    parent?: NbNode

    @db.rel.from 'up'
    children?: NbNode[]
}
