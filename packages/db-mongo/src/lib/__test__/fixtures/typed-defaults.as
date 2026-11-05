// `@db.default` as a literal of the field's type: number, boolean, string.
@db.table 'typed_defaults'
export interface TypedDefaults {
    @meta.id
    id: number

    @db.default 0
    attempts: number.int

    @db.default -1.5
    delta: number

    @db.default true
    enabled: boolean

    @db.default false
    archived: boolean

    @db.default "active"
    status: string

    @db.default 10.50
    price: decimal
}
