// `number.timestamp.created` carries `@db.default.now` (atscript 0.1.104):
// a field typed with it behaves like an explicit `@db.default.now`.
export type Created = number.timestamp.created

@db.table 'pd_source'
export interface PdSource {
    @meta.id
    id: number

    createdAt: number.timestamp.created

    closedAt: number.timestamp.created | null
}

@db.table 'pd_events'
export interface PdEvent {
    @meta.id
    id: number

    createdAt: number.timestamp.created

    createdOpt?: number.timestamp.created

    aliased: Created

    nullable: number.timestamp.created | null

    @db.default '5'
    overridden: number.timestamp.created

    audit: {
        at: number.timestamp.created
        @db.default 'system'
        by: string
    }

    maybeAudit?: {
        at: number.timestamp.created
    } | null

    updatedAt: number.timestamp.updated

    mixed: number.timestamp.created | string

    pair: [number.timestamp.created, string]

    stamps: number.timestamp.created[]

    // a reference to another field does not copy its default
    sourceCreatedAt: PdSource.createdAt

    sourceClosedAt: PdSource.closedAt

    name: string.required

    history: {
        at: number.timestamp.created
        note: string
    }[]

    @db.json
    payload: {
        at: number.timestamp.created
    }

    // below a tuple or a union of several types a default has no certain
    // place: not filled, and the field is required
    @db.json
    steps: [{ at: number.timestamp.created }, { note: string }]

    @db.json
    events: ({ kind: 'open', at: number.timestamp.created } | { kind: 'note', text: string })[]
}
