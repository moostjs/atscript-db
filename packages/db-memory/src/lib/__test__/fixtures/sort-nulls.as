// NULL placement in sorts (since 0.1.153): `$nulls` and `@db.sort.nulls`.

@db.table 'sn_rows'
export interface SnRow {
    @meta.id
    id: number

    grp: string
    amount?: number

    @db.sort.nulls 'last'
    closedAt?: number
}
