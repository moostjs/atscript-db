// Fixture for query-guards-paths.spec.ts / nullable-types.spec.ts — one table
// carrying every path kind the core path guard classifies: scalar leaves
// (indexed and not), a flattened object, a @db.json object, a primitive
// array, an array of objects, an encrypted object, a geo point, an FK and a
// navigation relation; plus optional string / number / boolean leaves for the
// nullable-typing checks.

@db.table 'guard_targets'
export interface GuardTarget {
    @meta.id
    id: number

    name: string
}

@db.table 'guard_sources'
export interface GuardSource {
    @meta.id
    id: number

    title: string

    @db.index.plain
    rank: number

    note?: string

    score?: number

    archived?: boolean

    contact: {
        email: string
        phone?: string
    }

    @db.json
    ctx: {
        sub: string
        deep: {
            leaf: number
        }
    }

    tags: string[]

    items: {
        sku: string
        qty: number
    }[]

    @db.encrypted
    credentials?: {
        user: string
        pwd: string
    }

    @db.index.geo
    geo: db.geoPoint

    @db.rel.FK
    targetId: GuardTarget.id

    @db.rel.to
    target?: GuardTarget
}
