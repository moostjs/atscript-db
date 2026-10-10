// Fixture for pk-retarget.live.spec.ts — a parent's primary key moves from
// `code` to `alt` and the child retargets its foreign key in the same sync.

@db.table 'pkr_parents'
export interface PkrParentBefore {
    @meta.id
    @expect.maxLength 64
    code: string

    @expect.maxLength 64
    @db.index.unique 'pkr_alt_uq'
    alt: string

    name: string
}

@db.table 'pkr_children'
export interface PkrChildBefore {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    parentRef: PkrParentBefore.code
}

@db.table 'pkr_parents'
export interface PkrParentAfter {
    @expect.maxLength 64
    @db.index.unique 'pkr_code_uq'
    code: string

    @meta.id
    @expect.maxLength 64
    alt: string

    name: string
}

@db.table 'pkr_children'
export interface PkrChildAfter {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    parentRef: PkrParentAfter.alt
}
