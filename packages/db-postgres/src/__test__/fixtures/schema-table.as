@db.schema 'app'
@db.table 'schema_items'
export interface SchemaItemsTable {
    @meta.id
    @db.default.increment
    id: number

    name: string
}
