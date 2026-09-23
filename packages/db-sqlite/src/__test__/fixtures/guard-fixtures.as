// Fixtures for json-subfield-gate.spec.ts / json-exists.spec.ts /
// mixed-logical-filter.spec.ts / null-semantics.spec.ts (real in-memory SQLite).

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

// json-exists.spec.ts — optional JSON-stored columns (a @db.json object, a
// primitive array, and a @db.json child of a flattened object) written as
// object, `{}` / `[]`, explicit null and absent.
@db.table 'json_exists_docs'
export interface JsonExistsDoc {
    @meta.id
    @db.default.increment
    id: number

    label: string

    @db.json
    metrics?: {
        value?: number
    }

    tags?: string[]

    wrap: {
        title?: string
        @db.json
        blob?: {
            v?: number
        }
    }
}
