// Fixture for depth-limit-meta.spec.ts — exercises how @db.depth.limit
// shapes the serialized `refDepth` on /meta responses.

// ── Three-table chain for @db.depth.limit 2 ───────────────────────────
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

// Root table with @db.depth.limit 2, FK → Mid (nested-to chain).
@db.table 'root_two'
@db.depth.limit 2
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
@db.depth.limit 0
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
