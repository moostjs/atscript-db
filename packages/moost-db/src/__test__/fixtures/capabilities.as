// Fixture for meta-capabilities.spec.ts — every path kind the capability index
// classifies, on one table, so the /meta ⇔ gate parity can be asserted over
// real compiled metadata on both adapter families.

@db.table 'cap_targets'
export interface CapTarget {
    @meta.id
    id: number

    name: string
}

@db.table 'cap_rows'
export interface CapRow {
    @meta.id
    id: number

    title: string

    @db.index.plain
    rank: number

    contact: {
        email: string
        phone?: string
    }

    @db.json
    prefs: {
        theme: string
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
    secret?: {
        user: string
        pwd: string
    }

    @db.index.geo
    geo: db.geoPoint

    @db.writeOnly
    apiSecret?: string

    @db.rel.FK
    targetId: CapTarget.id

    @db.rel.to
    target?: CapTarget
}

@db.table 'cap_manual'
@db.table.filterable 'manual'
@db.table.sortable 'manual'
export interface CapManual {
    @meta.id
    id: number

    @db.column.filterable
    @db.column.sortable
    name: string

    other: string

    @db.column.filterable
    @db.column.sortable
    @db.json
    prefs: {
        a: string
    }
}
