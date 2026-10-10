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

// Leaves several members declare with different types
@db.table 'uc_shapes'
export interface UcShape {
    @meta.id
    id: number

    // same leaf, scalar types disagree → a text column, like `string | number`
    conf: { x: number } | { x: string }

    // same leaf, an object in one member → that leaf is one JSON column
    deep: { x: number } | { x: { y: number } }

    // a union of objects inside a nullable object
    outer: {
        inner: UcCard | UcBank
    } | null
}
