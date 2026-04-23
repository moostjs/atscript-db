// Conventional @db.table interface — establishes that @db.rel.FK
// on a @db.table host still validates after F1 is relaxed (the
// relaxation is purely additive).

@db.table 'roles'
export interface Role {
    @meta.id
    @db.default.increment
    id: number

    name: string
}
