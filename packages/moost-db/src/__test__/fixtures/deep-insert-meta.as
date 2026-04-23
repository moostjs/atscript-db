// Fixture for deep-insert-meta.spec.ts — exercises how @db.deep.insert
// shapes the serialized `refDepth` on /meta responses.

// ── Three-table chain for @db.deep.insert 2 ───────────────────────────
// Leaf table (no further FK).
@db.table 'leaf'
export interface Leaf {
    @meta.id
    @db.default.increment
    id: number

    tag: string
}

// Mid table FK → Leaf.
@db.table 'mid'
export interface Mid {
    @meta.id
    @db.default.increment
    id: number

    label: string

    @db.rel.FK
    leafId: Leaf.id

    @db.rel.to
    leaf?: Leaf
}

// Root table with @db.deep.insert 2, FK → Mid.
@db.table 'root_two'
@db.deep.insert 2
export interface RootTwo {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.FK
    midId: Mid.id

    @db.rel.to
    mid?: Mid
}

// ── Shallow-ref cases: annotation=0 and no annotation ─────────────────
@db.table 'root_zero'
@db.deep.insert 0
export interface RootZero {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.FK
    leafId: Leaf.id

    @db.rel.to
    leaf?: Leaf
}

@db.table 'root_none'
export interface RootNone {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.FK
    leafId: Leaf.id

    @db.rel.to
    leaf?: Leaf
}
