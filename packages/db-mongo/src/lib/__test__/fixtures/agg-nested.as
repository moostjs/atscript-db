@db.table 'agg_widgets'
export interface AggWidgets {
    @meta.id
    id: number

    name: string

    category: string

    metadata: {
        clicks: number
        impressions: number
    }
}
