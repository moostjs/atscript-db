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
// POINT column with its `[lng, lat]` values.
@db.table 'uc_geo'
export interface UcGeo {
    @meta.id
    id: number

    geo?: db.geoPoint | null
}

// Several 0.1.155 layout changes on one table of the earlier layout: a
// `T | null` object in a JSON text column, a `number.timestamp.created`
// column gaining its default, an embedded type's `@meta.id` leaving the
// primary key.
export interface UcLine {
    @meta.id
    lineId: string
    qty: number
}

@db.table 'uc_legacy_mixed'
export interface UcLegacyMixed {
    @meta.id
    id: number
    line: UcLine
    created: number.timestamp.created
    addr: UcAddr | null
}

// An object that leaves `@db.json`: its JSON is copied into flattened
// columns, some of them NOT NULL.
@db.table 'uc_unjson'
export interface UcUnjsonOld {
    @meta.id
    id: number

    @db.json
    addr: UcAddr
}

@db.table 'uc_unjson'
export interface UcUnjson {
    @meta.id
    id: number

    addr: UcAddr
}

// A `T | null` object whose type has its own `@meta.id`: the earlier layout
// keyed the table by its unused dot-named column (`line.lineId`) too.
@db.table 'uc_legacy_line'
export interface UcLegacyLine {
    @meta.id
    id: number
    line: UcLine | null
}
