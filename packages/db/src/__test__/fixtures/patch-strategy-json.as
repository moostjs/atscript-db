// Fixture for patch-strategy-json.spec.ts (since 0.1.184): one type with a
// merge-strategy field, placed where a patch reaches it by its own path and
// where it does not (the build checks the annotation where it is written).

export interface PsjPrefs {
    @db.patch.strategy 'merge'
    theme?: {
        dark?: boolean
    }
}

@db.table 'psj_ref'
export interface PsjRef {
    @meta.id
    id: number

    @db.patch.strategy 'merge'
    flat?: PsjPrefs

    maybe?: PsjPrefs | null

    @db.patch.strategy 'merge'
    keyed?: {
        @expect.array.key
        k: string
    }[]

    @db.json
    json?: PsjPrefs

    @db.encrypted
    secret?: PsjPrefs

    list?: PsjPrefs[]

    union?: PsjPrefs | string

    tuple?: [PsjPrefs, number]
}
