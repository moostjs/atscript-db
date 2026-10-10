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
}

@db.table 'ts_upgrade'
export interface TsAfter {
    @meta.id
    id: number
    createdAt: number.timestamp.created
}

// A composite key losing a member (what the embedded-id fix does to a key).
@db.table 'key_shrink'
export interface KeyBefore {
    @meta.id
    id: number
    @meta.id
    seq: number
    note: string
}

@db.table 'key_shrink'
export interface KeyAfter {
    @meta.id
    id: number
    seq: number
    note: string
}
