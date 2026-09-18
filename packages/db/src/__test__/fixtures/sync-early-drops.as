// Fixtures for early drops: a removed table that references a table the run
// drops and recreates (`@db.sync.method 'drop'`) is dropped right before it.
// The same physical name appears in two versions so one DbSpace can sync the
// "before" model and then the "after" model (a REAL → TEXT type change).

// ── T: drop-and-recreate on a type change ───────────────────────────────

@db.table 'ed_parents'
@db.sync.method 'drop'
export interface EdParentV1 {
    @meta.id
    @db.default.increment
    id: number

    priority: number
}

// `priority` becomes a string → type change → drop and recreate
@db.table 'ed_parents'
@db.sync.method 'drop'
export interface EdParentV2 {
    @meta.id
    @db.default.increment
    id: number

    priority: string
}

// ── R1 → T, R2 → R1: removed in the "after" inventory ───────────────────

@db.table 'ed_children'
export interface EdChild {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    parentId: EdParentV1.id
}

@db.table 'ed_grandchildren'
export interface EdGrandchild {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    childId: EdChild.id
}

// ── Removed, unrelated to T (stays in the late drop pass) ───────────────

@db.table 'ed_bystanders'
export interface EdBystander {
    @meta.id
    @db.default.increment
    id: number

    name: string
}

// ── Stays in the inventory; sorts after ed_parents so it runs after T ───

@db.table 'ed_survivors'
export interface EdSurvivor {
    @meta.id
    @db.default.increment
    id: number

    name: string
}
