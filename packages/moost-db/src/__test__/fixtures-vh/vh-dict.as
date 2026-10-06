// A dictionary with a composite key — a `test.vh` binding target.
@db.table 'vh_dict'
export interface VhDict {
    @meta.id
    attribute: string

    @meta.id
    value: string

    label: string
}
