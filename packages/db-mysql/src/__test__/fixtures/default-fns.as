@db.table 'tokens'
export interface TokenTable {
    @meta.id
    @db.default.uuid
    id: string

    label: string

    @db.default.now
    createdAt?: number.timestamp.created
}

@db.table 'counters'
export interface CounterTable {
    @meta.id
    @db.default.increment 1000
    id: number

    label: string

    @db.default.now
    createdAt?: number.timestamp.created
}

@db.table 'simple_counters'
export interface SimpleCounterTable {
    @meta.id
    @db.default.increment
    id: number

    label: string
}
