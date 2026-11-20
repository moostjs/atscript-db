// `$update` on embedded arrays (array-update-strategy-server.spec.ts): the
// default patch strategy replaces the matched element, `merge` merges into
// it, and an array without key props is left as it is (since 0.1.180).

@db.table 'aus_items'
export interface AusItem {
    @meta.id
    id: number

    plain?: {
        @expect.array.key
        sku: string
        qty: number
        note?: string
    }[]

    @db.patch.strategy 'merge'
    merged?: {
        @expect.array.key
        sku: string
        qty: number
        note?: string
    }[]

    keyless?: {
        label: string
        note?: string
    }[]

    tags?: string[]

    // a replace-strategy nested object holding an array
    box?: {
        caption?: string
        labels?: string[]
    }

    secret?: string
}
