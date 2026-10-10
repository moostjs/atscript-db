// `T | null` unions and unions of objects in `/meta` (since 0.1.155).

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

// A null test on `creds` would probe its writeOnly leaf.
@db.table 'uc_accounts'
export interface UcAccount {
    @meta.id
    id: number

    creds?: {
        @db.writeOnly
        hash: string
        hint?: string
    }
}
