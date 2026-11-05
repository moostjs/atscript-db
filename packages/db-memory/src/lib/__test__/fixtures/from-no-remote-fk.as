// A FROM relation whose child has no foreign key to THIS table: the
// relation is inherited by a table that extends the one the child points to.
@db.table 'fr_parents'
@db.depth.limit 2
export interface FrParent {
    @meta.id
    id: number

    label: string

    @db.rel.from
    kids?: FrKid[]
}

@db.table 'fr_kids'
export interface FrKid {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    parentId?: FrParent.id

    note: string
}

@db.table 'fr_special'
@db.depth.limit 2
export interface FrSpecial extends FrParent {
    extra?: string
}
