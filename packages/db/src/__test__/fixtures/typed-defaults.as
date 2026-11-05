// `@db.default` written as a literal of the field's type (number, boolean,
// string) next to the string form, which non-string fields parse as JSON.
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

    @db.default 'a'
    tier: 'a' | 'b'

    @db.default 10.50
    price: decimal

    @db.default "0"
    legacyCount: number

    @db.default "true"
    legacyFlag: boolean
}

// The same columns in the string form only — the schema hash must match.
@db.table 'typed_defaults'
export interface TypedDefaultsAsStrings {
    @meta.id
    id: number

    @db.default "0"
    attempts: number.int

    @db.default "-1.5"
    delta: number

    @db.default "true"
    enabled: boolean

    @db.default "false"
    archived: boolean

    @db.default "active"
    status: string

    @db.default 'a'
    tier: 'a' | 'b'

    @db.default "10.50"
    price: decimal

    @db.default "0"
    legacyCount: number

    @db.default "true"
    legacyFlag: boolean
}
