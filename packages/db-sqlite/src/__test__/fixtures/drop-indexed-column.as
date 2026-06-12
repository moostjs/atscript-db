// Before/after pair for the "drop indexed column" sync scenario:
// V1 creates indexed columns, V2 removes them (annotations gone with the
// fields). SQLite refuses ALTER TABLE … DROP COLUMN while an index still
// references the column, so sync must drop managed indexes first.

@db.table 'drop_idx_gadgets'
export interface DropIdxGadgetV1 {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.index.unique 'didx_email'
    email?: string

    @db.index.plain 'didx_code'
    code?: string

    @db.index.plain 'didx_region_status'
    region?: string

    @db.index.plain 'didx_region_status'
    status?: string
}

@db.table 'drop_idx_gadgets'
export interface DropIdxGadgetV2 {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.index.plain 'didx_region_status'
    region?: string
}
