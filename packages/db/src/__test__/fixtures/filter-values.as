// Filter values checked against the field's declared type (filter-values.spec.ts). Since 0.1.147.

@db.table 'fv_owners'
export interface FvOwner {
    @meta.id
    id: number

    name: string

    @db.rel.from
    @db.rel.filterable
    items?: FvItem[]
}

@db.table 'fv_items'
export interface FvItem {
    @meta.id
    id: number

    n: number

    qty: number.int

    ts: number.timestamp

    flag: boolean

    label: string

    email?: string.email

    price: decimal

    kind: 'a' | 'b'

    level: 1 | 2 | 3

    mixed?: number | boolean

    tags: string[]

    scores: number[]

    @db.json
    blob?: {
        v: number
    }

    @db.rel.FK
    ownerId?: FvOwner.id

    @db.rel.to
    @db.rel.filterable
    owner?: FvOwner
}
