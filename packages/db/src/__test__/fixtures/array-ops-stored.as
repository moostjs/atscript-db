// Fixtures for array-ops-stored.spec.ts (since 0.1.178): array patch operators
// read the stored value as a read would — through the column's `fromStorage`.

@db.table 'aos_items'
export interface AosItem {
    @meta.id
    id: number

    scores?: number[]

    @db.column 'w_col'
    weights?: number[]

    tags?: string[]
}

// A renamed and a flattened array column keep their `uniqueItems` and merge
// strategy under array patch operators (looked up by the logical path).
@db.table 'aos_renamed'
export interface AosRenamed {
    @meta.id
    id: number

    @db.column 'u_col'
    @expect.array.uniqueItems
    uniq?: string[]

    @db.column 'm_col'
    @db.patch.strategy 'merge'
    merged?: {
        @expect.array.key
        sku: string
        qty: number
        note?: string
    }[]

    box?: {
        @expect.array.uniqueItems
        labels?: string[]
    }
}

// `$update` follows the array's patch strategy (since 0.1.180): the default
// replaces the matched element, `merge` merges into it.
@db.table 'aos_keyed'
export interface AosKeyed {
    @meta.id
    id: number

    plain?: {
        @expect.array.key
        sku: string
        qty: number
        note?: string
    }[]

    @db.patch.strategy 'merge'
    merged?: {
        @expect.array.key
        sku: string
        qty: number
        note?: string
    }[]

    keyless?: {
        label: string
        note?: string
    }[]

    tags?: string[]
}
