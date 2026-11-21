// Arrays without key props whose elements are objects: an element equals an
// item whatever the order of the objects' properties, as on the other
// adapters (keyless-order*.spec.ts, since 0.1.182).

@db.table 'keyless_order'
export interface KeylessOrder {
    @meta.id
    id: number

    entries?: {
        label: string
        note?: string | null
        meta?: {
            a?: number
            b?: string
        }
        points?: {
            x: number
            y: number
        }[]
        codes?: string[]
    }[]

    @expect.array.uniqueItems
    uniq?: {
        name: string
        score: number
        extra?: {
            p: number
            q: number
        }
    }[]

    @db.patch.strategy 'merge'
    merged?: {
        a: number
        b: number
    }[]

    tags?: string[]

    @expect.array.uniqueItems
    uniqTags?: string[]

    secret?: string
}
