@db.table "vx_records"
export interface VxRecord {
    @meta.id
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

    @db.column.version.exempt
    tags: string[]
}
