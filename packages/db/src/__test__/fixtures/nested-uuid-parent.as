// A parent whose string primary key the database generates (`@db.default.uuid`
// on an adapter with a native uuid default), with nested FROM children.
@db.table 'nu_parents'
@db.depth.limit 1
export interface NuParent {
    @meta.id
    @db.default.uuid
    id: string.uuid

    label: string

    @db.rel.from
    kids?: NuKid[]
}

@db.table 'nu_kids'
export interface NuKid {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    parentId?: NuParent.id

    note: string
}
