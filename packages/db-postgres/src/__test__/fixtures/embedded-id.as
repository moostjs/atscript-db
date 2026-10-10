// An embedded object's own `@meta.id` identifies that object, not the host row.
export interface EmbLine {
    @meta.id
    lineId: string
    qty: number
}

@db.table 'emb_orders'
export interface EmbOrder {
    @meta.id
    id: number
    line: EmbLine
    createdAt: number.timestamp.created
    audit: {
        at: number.timestamp.created
    }
}

// The same table before and after the upgrade: `number.timestamp` (no default)
// becoming `number.timestamp.created`.
@db.table 'ts_upgrade'
export interface TsBefore {
    @meta.id
    id: number
    createdAt: number.timestamp
    audit: {
        at: number.timestamp
    }
}

@db.table 'ts_upgrade'
export interface TsAfter {
    @meta.id
    id: number
    createdAt: number.timestamp.created
    audit: {
        at: number.timestamp.created
    }
}

// `T | null` of a timestamp: a TEXT column up to 0.1.154 (a union), a nullable
// timestamp column with the `now` default since 0.1.155.
@db.table 'ts_nullable'
export interface TsNullable {
    @meta.id
    id: number
    closedAt: number.timestamp.created | null
}

// An absent optional object / another union member's leaves: the columns'
// `now` default must not make them appear on read.
export interface TsCard {
    kind: 'card'
    at: number.timestamp.created
}

export interface TsBank {
    kind: 'bank'
    iban: string
}

@db.table 'ts_absent'
export interface TsAbsent {
    @meta.id
    id: number
    audit?: {
        at: number.timestamp.created
    }
    pay?: TsCard | TsBank
}
