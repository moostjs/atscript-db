// Fixtures for json-subfield-gate.spec.ts / mixed-logical-filter.spec.ts /
// null-semantics.spec.ts (real in-memory SQLite).

@db.table 'gate_widgets'
export interface GateWidget {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.json
    metadata: {
        clicks: number
        impressions: number
    }

    tags: string[]
}

@db.table 'jobs'
export interface Job {
    @meta.id
    id: number

    nextRefreshAt: number

    a: number

    b: number

    state: string

    @db.default 'false'
    flag?: boolean
}

@db.table 'notes'
export interface Note {
    @meta.id
    @db.default.increment
    id: number

    title: string

    note?: string

    score?: number

    archived?: boolean
}
