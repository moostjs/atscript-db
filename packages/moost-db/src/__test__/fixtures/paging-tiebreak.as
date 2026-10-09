// Deterministic paging (since 0.1.153): `/pages` without `$sort` reads in
// primary-key order; with `$sort`, ties come back in primary-key order.

@db.table 'pt_http_rows'
export interface PtHttpRow {
    @meta.id
    id: number

    grp: number
}
