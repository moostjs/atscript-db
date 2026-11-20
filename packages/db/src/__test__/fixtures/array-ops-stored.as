// Fixtures for array-ops-stored.spec.ts (since 0.1.178): array patch operators
// read the stored value as a read would — through the column's `fromStorage`.

@db.table 'aos_items'
export interface AosItem {
    @meta.id
    id: number

    scores?: number[]

    @db.column 'w_col'
    weights?: number[]

    tags?: string[]
}
