// `updateMany` with array patch operators (since 0.1.182) — exercised by
// `update-many-array-ops-server.spec.ts`.

@db.table 'uma_items'
export interface UmaItem {
    @meta.id
    id: number

    status: string

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
        caption?: string
        labels?: string[]
    }

    outer?: {
        title?: string
        @db.patch.strategy 'merge'
        minner?: {
            note?: string
            labels?: string[]
        }
    }

    @db.column.version
    version: number.int

    @db.column.version.exempt
    seen?: string[]
}

// No version column and no stamps: an operator with nothing to apply sets nothing
@db.table 'uma_plain'
export interface UmaPlain {
    @meta.id
    id: number

    status: string

    tags?: string[]
}
