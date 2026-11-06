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

// Defaults under `@normalize.*`: the backfill is what an insert stores.
@normalize.trim
@normalize.lowercase
export type NormalizedTag = string

@db.table 'normalized_defaults'
export interface NormalizedDefaults {
    @meta.id
    id: number

    @db.default ' Pending '
    @normalize.trim
    @normalize.uppercase
    code: string

    @db.default '[" A ", "b"]'
    tags: NormalizedTag[]
}
