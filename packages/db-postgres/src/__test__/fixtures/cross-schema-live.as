// Foreign keys into a table of ANOTHER schema (PostgreSQL schema / MySQL
// database): DDL must qualify `REFERENCES` with the target's @db.schema.

@db.table 'xs_owners'
@db.schema 'relfix_xs'
export interface XsOwner {
    @meta.id
    id: string

    name: string

    @db.rel.from
    @db.rel.filterable
    items?: XsItem[]
}

@db.table 'xs_items'
export interface XsItem {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    ownerId?: XsOwner.id

    @db.rel.to
    @db.rel.filterable
    owner?: XsOwner
}

// No @db.schema: lives in the connection's current schema.
@db.table 'xs_plain'
export interface XsPlain {
    @meta.id
    id: number

    label: string
}
