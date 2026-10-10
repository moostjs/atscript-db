// An embedded document's own `@meta.id` identifies that document, not the host.
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
    lines: EmbLine[]
    createdAt: number.timestamp.created
    audit?: {
        at: number.timestamp.created
    }
}

@db.table 'emb_docs'
@db.mongo.collection
export interface EmbDoc {
    @meta.id
    code: string
    line: EmbLine
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
