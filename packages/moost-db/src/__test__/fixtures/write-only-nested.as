// Fixture for write-only-nested.spec.ts: a nested object with a write-only
// leaf, read as the bound table and as a `$with` target.

@db.table 'wo_nested_owners'
export interface WoNestedOwner {
    @meta.id
    id: number

    title: string

    secret: {
        @db.writeOnly
        hash: string

        salt: string
    }
}

@db.table 'wo_nested_children'
export interface WoNestedChild {
    @meta.id
    id: number

    @db.rel.FK
    ownerId: WoNestedOwner.id

    @db.rel.to
    owner?: WoNestedOwner
}

export interface WoNestedDecorations {
    digest?: string
}

// Two hops to the sealed leaf — a dotted `$with` (`child.owner`, since 0.1.165).
@db.table 'wo_nested_grandchildren'
export interface WoNestedGrandchild {
    @meta.id
    id: number

    @db.rel.FK
    childId: WoNestedChild.id

    @db.rel.to
    child?: WoNestedChild
}
