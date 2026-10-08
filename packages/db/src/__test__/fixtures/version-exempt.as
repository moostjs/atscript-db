@db.table "vx_records"
export interface VxRecord {
    @meta.id
    @db.default.increment
    id: number

    title: string
    status: string

    @db.column.version
    version: number.int

    @db.column.version.exempt
    score: number

    @db.column.version.exempt
    hits: number

    @db.column.version.exempt
    metrics: { impact: number, rank?: number }

    stats: {
        @db.column.version.exempt
        views: number
        @db.column.version.exempt
        lastViewedAt?: number
    }

    @db.patch.strategy "merge"
    mixed: {
        @db.column.version.exempt
        cached: number
        label: string
    }

    @db.column.version.exempt
    tags: string[]
}

@db.table "vx_plain"
export interface VxPlain {
    @meta.id
    id: number

    @db.column.version.exempt
    score: number
}
