// `T | null` unions and unions of objects — the same reads, filters and
// sorts as on the relational adapters (since 0.1.155).

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

@db.table 'uc_orders'
export interface UcOrder {
    @meta.id
    id: number

    qty: number.int | null

    payment: UcCard | UcBank

    refund: UcCard | UcBank | null

    extra: UcCard | string
}

@db.table 'uc_coded'
export interface UcCoded {
    @meta.id
    id: number

    @db.index.unique 'uc_code'
    code: string | null
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

// Patches of objects: a renamed merge-strategy object merges, `@db.json`
// and `T | null` objects are replaced whole.
@db.table 'uc_profiles'
export interface UcProfile {
    @meta.id
    id: number

    @db.column 'renm'
    @db.patch.strategy 'merge'
    merged: {
        name: string
        age?: number
    }

    @db.json
    blob: {
        name: string
        age?: number
    }

    maybe: {
        name: string
        age?: number
    } | null
}
