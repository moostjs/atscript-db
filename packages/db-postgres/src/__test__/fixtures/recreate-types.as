// `recreateTable` copy step with changed column types (since 0.1.137): each
// comment names the column's OLD type as the test driver reports it.

@db.table 'rt_items'
@db.sync.method 'recreate'
export interface RtItem {
    // unchanged DOUBLE PRECISION primary key
    @meta.id
    id: number

    // was DOUBLE PRECISION, required
    priority: string

    // was TEXT, optional
    score?: number

    // was TEXT, required → VARCHAR(3)
    @expect.maxLength 3
    code: string

    // unchanged TEXT, required
    label: string

    // unchanged BOOLEAN, optional
    flag?: boolean
}
