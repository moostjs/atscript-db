// An embedded type's own `@meta.id` identifies that object, not the host row:
// only the host's top-level `@meta.id` fields form its primary key.
export interface EmbLine {
    @meta.id
    lineId: string
    qty: number
}

export interface EmbWrapper {
    @meta.id
    wid: number
    line: EmbLine
}

@db.table 'emb_target'
export interface EmbTarget {
    @meta.id
    id: number
    name: string
}

@db.table 'emb_orders'
export interface EmbOrder {
    @meta.id
    id: number

    line: EmbLine

    lineOpt?: EmbLine

    lineNull: EmbLine | null

    @db.json
    lineJson: EmbLine

    lines: EmbLine[]

    wrap: EmbWrapper

    inline: {
        @meta.id
        @db.default.uuid
        sub: string
        v: number
    }

    // an embedded @db.table type is still just an embedded object here
    target: EmbTarget

    @db.rel.FK
    targetId: EmbTarget.id

    @db.rel.to
    targetNav?: EmbTarget
}

@db.table 'emb_composite'
export interface EmbComposite {
    @meta.id
    a: number

    @meta.id
    b: string

    line: EmbLine
}

@db.table 'emb_no_id'
export interface EmbNoId {
    name: string
    line: EmbLine
}
