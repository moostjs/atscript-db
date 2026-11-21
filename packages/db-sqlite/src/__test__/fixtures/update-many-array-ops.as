// `updateMany` with array patch operators (since 0.1.182) — exercised by
// `update-many-array-ops.spec.ts`.

@db.table 'uma_items'
export interface UmaItem {
    @meta.id
    id: number

    status: string

    @db.index.unique 'uma_code_idx'
    code?: string

    tags?: string[]

    @expect.array.uniqueItems
    uniq?: string[]

    variants?: {
        @expect.array.key
        sku: string
        qty: number
        note?: string
    }[]

    @db.patch.strategy 'merge'
    attrs?: {
        @expect.array.key
        name: string
        value: string
        unit?: string
    }[]

    notes?: {
        text: string
        author?: string
    }[]

    box?: {
        labels?: string[]
    }

    @db.column.version
    version: number.int

    @db.column.version.exempt
    seen?: string[]
}

@db.table 'uma_pairs'
export interface UmaPair {
    @meta.id
    org: string

    @meta.id
    code: number

    tags?: string[]
}
