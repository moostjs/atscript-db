// `@db.default` literals under `@normalize.*` (normalized-defaults.spec.ts).

@normalize.trim
@normalize.lowercase
export type NdLabel = string

@db.table 'nd_items'
export interface NdItem {
    @meta.id
    id: number

    @db.default 'NEW'
    @normalize.lowercase
    status?: string

    @db.default 'done'
    @normalize.lowercase
    settled?: string

    @db.default '  Plain  '
    plain?: string

    @db.default '  Spaced  '
    @normalize.trim
    trimmed?: string

    @db.default '[" A ", "b"]'
    labels?: NdLabel[]

    @db.default 3
    count?: number
}
