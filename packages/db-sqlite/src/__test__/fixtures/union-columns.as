// `T | null` unions and unions of objects on relational storage (since
// 0.1.155): a nullable union is a nullable column of T's type, a union of
// objects is flattened like a nested object (member-only leaves nullable),
// a union mixing an object with another type is one JSON column.

export interface UcCard {
    kind: 'card'
    card: string
    amount: number
}

export interface UcBank {
    kind: 'bank'
    iban: string
    amount: number
    bic?: string
}

export interface UcAddr {
    street: string
    zip?: string
}

@expect.maxLength 10
export type UcShort = string

@db.table 'uc_orders'
export interface UcOrder {
    @meta.id
    id: number

    note: string | null

    qty: number.int | null

    paid: boolean | null

    status: 'open' | 'closed' | null

    code: UcShort | null

    tags: string[] | null

    addr: UcAddr | null

    payment: UcCard | UcBank

    refund: UcCard | UcBank | null

    extra: UcAddr | string

    shipping?: {
        street: string
        city: string
    }
}

// The same table name as an earlier atscript-db version laid it out — see
// `union-columns.spec.ts` (sync from the old shape).
@db.table 'uc_legacy'
@db.sync.method 'recreate'
export interface UcLegacy {
    @meta.id
    id: number

    note: string | null

    qty: number | null

    addr: UcAddr | null

    refund: UcCard | UcBank | null

    extra: UcAddr | string
}

// A malformed JSON value in the old column refuses the sync.
@db.table 'uc_legacy_bad'
export interface UcLegacyBad {
    @meta.id
    id: number

    addr: UcAddr | null
}

// The documented way to keep an old union column's data: `@db.json`.
@db.table 'uc_legacy_json'
export interface UcLegacyJson {
    @meta.id
    id: number

    @db.json
    addr: UcAddr | null
}

// An object whose fields are all optional: stored as `{}` it still counts
// as null for `{ meta: null }` (no field holds a value).
@db.table 'uc_notes'
export interface UcNote {
    @meta.id
    id: number

    meta?: {
        tag?: string
        n?: number
    }
}

// A copy target with a `@db.default` refuses the sync (ADD COLUMN fills it).
@db.table 'uc_legacy_default'
export interface UcLegacyDefault {
    @meta.id
    id: number

    addr: {
        street?: string
        @db.default 'D'
        zip?: string
    } | null
}

// The same table first synced with `addr` as a plain string, then retyped to
// an object: the old column is no JSON text and is dropped as usual.
@db.table 'uc_retyped'
export interface UcRetypedOld {
    @meta.id
    id: number

    addr: string
}

@db.table 'uc_retyped'
export interface UcRetyped {
    @meta.id
    id: number

    addr: UcAddr | null
}
