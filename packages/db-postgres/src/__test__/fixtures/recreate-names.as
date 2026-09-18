// Fixtures for `recreateTable` constraint handling (since 0.1.129): a table
// with a self-referencing FK, and one whose name pushes the temp
// table's auto-generated constraint names past the 63-byte identifier limit.

@db.table 'rn_folders'
export interface RnFolder {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.FK
    parentId?: RnFolder.id
}

@db.table 'rn_a_long_table_name_past_the_pg_limit_x_1234'
export interface RnLongName {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'rn_long_code'
    code: string

    @db.rel.FK
    folderId?: RnFolder.id
}
