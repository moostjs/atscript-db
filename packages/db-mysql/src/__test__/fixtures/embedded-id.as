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

// Keeping milliseconds through the upgrade: a TIMESTAMP(3) column.
@db.table 'ts_upgrade_ms'
export interface TsMsBefore {
    @meta.id
    id: number
    createdAt: number.timestamp
}

@db.table 'ts_upgrade_ms'
export interface TsMsAfter {
    @meta.id
    id: number
    @db.mysql.type "TIMESTAMP(3)"
    createdAt: number.timestamp.created
}

@db.table 'ts_explicit'
export interface TsExplicit {
    @meta.id
    id: number
    @db.default.now
    createdAt: number.timestamp
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

// A key column converted from epoch ms to TIMESTAMP while leaving the key ...
@db.table 'ts_rekey_leave'
export interface TsLeaveBefore {
    @meta.id
    id: number
    @meta.id
    createdAt: number.timestamp
}

@db.table 'ts_rekey_leave'
export interface TsLeaveAfter {
    @meta.id
    id: number
    createdAt: number.timestamp.created
}

// ... or entering it.
@db.table 'ts_rekey_enter'
export interface TsEnterBefore {
    @meta.id
    id: number
    createdAt: number.timestamp
}

@db.table 'ts_rekey_enter'
export interface TsEnterAfter {
    @meta.id
    id: number
    @meta.id
    createdAt: number.timestamp.created
}
