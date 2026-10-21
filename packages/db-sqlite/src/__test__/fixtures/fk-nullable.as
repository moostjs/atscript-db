// `@db.rel.FK` on `Target.id | null` (fk-nullable.spec.ts). Since 0.1.165.

@db.table 'fkn_people'
export interface FknPerson {
    @meta.id
    id: number.int

    name: string
}

@db.table 'fkn_items'
export interface FknItem {
    @meta.id
    id: number.int

    @db.rel.FK
    ownerId: FknPerson.id | null

    @db.rel.to
    owner?: FknPerson
}
