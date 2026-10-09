// Native TIMESTAMP / DATETIME columns of epoch-ms numbers (timestamps.spec.ts). Since 0.1.151.

@db.table 'ts_items'
export interface TsItem {
    @meta.id
    id: number

    @db.default.now
    createdAt?: number.timestamp

    @db.mysql.type 'TIMESTAMP(3)'
    @db.default.now
    @db.mysql.onUpdate 'CURRENT_TIMESTAMP'
    updatedAt?: number.timestamp

    @db.mysql.type 'DATETIME(6)'
    seenAt?: number

    @db.mysql.type 'DATETIME(2)'
    shortAt?: number

    @db.mysql.type 'BIGINT'
    @db.default.now
    epochAt?: number
}

@db.table 'ts_search'
export interface TsSearch {
    @meta.id
    id: number

    @db.index.fulltext 'ts_ft'
    title: string

    @db.search.vector 512, "cosine"
    embedding?: number[]
}
