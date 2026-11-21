// `updateMany` with the array operators `$insert` / `$upsert` / `$update` /
// `$remove` (since 0.1.182) — exercised by `update-many-array-ops.spec.ts`.

@db.table 'uma_items'
export interface UmaItem {
    @meta.id
    id: number

    status?: string

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

    @expect.array.uniqueItems
    uniq?: string[]

    @db.column 'w_col'
    weights?: number[]

    box?: {
        labels?: string[]
    }

    @db.onUpdate.inc
    rev: number.int
}

@db.table 'uma_pairs'
export interface UmaPair {
    @meta.id
    org: string

    @meta.id
    code: number

    tags?: string[]
}

@db.table 'uma_versioned'
export interface UmaVersioned {
    @meta.id
    id: number

    title?: string

    @db.column.version
    version: number.int

    @db.column.version.exempt
    tags?: string[]
}

// No primary key: the rows cannot be written one by one
@db.table 'uma_logs'
export interface UmaLog {
    line: string

    tags?: string[]
}
