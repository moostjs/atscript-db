// @db.column.derived — scalar columns computed from a @db.json leaf of the
// same row (derived-columns.spec.ts, derived-sync.spec.ts, schema-hash.spec.ts).

@db.table 'dv_orders'
export interface DvOrder {
    @meta.id
    id: number

    status: string

    @db.json
    payload: {
        customer: {
            id: string
            vip: boolean
            tier?: string
        }
        total: number
        note?: string
    }

    @db.json
    @db.column 'meta_json'
    meta?: {
        region: string
    }

    @db.column.derived
    @db.index.plain
    customerId: DvOrder.payload.customer.id

    @db.column.derived
    vip?: DvOrder.payload.customer.vip

    @db.column.derived
    amount: DvOrder.payload.total

    @db.column.derived
    @db.column 'region_code'
    @db.index.unique
    region?: DvOrder.meta.region

    @db.column.derived
    @db.column.collate 'nocase'
    tier?: DvOrder.payload.customer.tier
}

// A view reading a derived column: a plain column on SQL, the source path on
// document adapters.
@db.view 'dv_order_view'
@db.view.for DvOrder
export interface DvOrderView {
    id: DvOrder.id
    customer: DvOrder.customerId
    vip?: DvOrder.vip
}

// ── Schema-sync variants of one table (dv_sync) ──────────────────────────

// V0: no derived column yet
@db.table 'dv_sync'
export interface DvSyncV0 {
    @meta.id
    id: number

    @db.json
    payload: {
        customer: {
            id: string
            n: number
        }
        code?: string
    }
}

// V1: the derived column added later, indexed
@db.table 'dv_sync'
export interface DvSyncV1 {
    @meta.id
    id: number

    @db.json
    payload: {
        customer: {
            id: string
            n: number
        }
        code?: string
    }

    @db.column.derived
    @db.index.plain
    customerId?: DvSyncV1.payload.customer.id
}

// V2: the source path changed (expression change)
@db.table 'dv_sync'
export interface DvSyncV2 {
    @meta.id
    id: number

    @db.json
    payload: {
        customer: {
            id: string
            n: number
        }
        code?: string
    }

    @db.column.derived
    @db.index.plain
    customerId?: DvSyncV2.payload.code
}

// V3: the leaf type changed (string → number)
@db.table 'dv_sync'
export interface DvSyncV3 {
    @meta.id
    id: number

    @db.json
    payload: {
        customer: {
            id: string
            n: number
        }
        code?: string
    }

    @db.column.derived
    @db.index.plain
    customerId?: DvSyncV3.payload.customer.n
}

// V4: renamed
@db.table 'dv_sync'
export interface DvSyncV4 {
    @meta.id
    id: number

    @db.json
    payload: {
        customer: {
            id: string
            n: number
        }
        code?: string
    }

    @db.column.derived
    @db.column.renamed 'customerId'
    @db.index.plain
    custId?: DvSyncV4.payload.customer.id
}

// VK: the same name as a regular (stored) column — kind change both ways
@db.table 'dv_sync'
export interface DvSyncK {
    @meta.id
    id: number

    @db.json
    payload: {
        customer: {
            id: string
            n: number
        }
        code?: string
    }

    customerId?: string
}
