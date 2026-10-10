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

// Created with the layout an earlier atscript-db version gave it — see
// `union-columns.live.spec.ts` (sync from the old shape, in place).
@db.table 'uc_legacy'
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

// A JSON-stored field in a text column: node-postgres returns its JSON text.
@db.table 'uc_text_json'
export interface UcTextJson {
    @meta.id
    id: number

    @db.json
    @db.pg.type 'TEXT'
    data: UcAddr

    extra: UcAddr | string
}

// A copy target with a default: added without it (ADD COLUMN would fill
// every row), copied, then the default is applied.
@db.table 'uc_legacy_default'
export interface UcLegacyDefault {
    @meta.id
    id: number

    addr: {
        street?: string
        @db.default 'D'
        zip?: string
        @db.default.uuid
        ref?: string
    } | null
}

// `db.geoPoint | null`: a text column of the earlier union layout becomes a
// geography column with its `[lng, lat]` values.
@db.table 'uc_geo'
export interface UcGeo {
    @meta.id
    id: number

    geo?: db.geoPoint | null
}
