// Filter values checked against the column type over HTTP (filter-values.spec.ts). Since 0.1.147.

@db.table 'tf_http_items'
export interface TfHttpItem {
    @meta.id
    id: number

    n: number

    ts: number.timestamp

    flag: boolean

    label: string

    price: decimal

    @db.default.now
    createdIso?: string.isoDate
}
