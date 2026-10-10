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
