// Fixture for agg-buckets-server.spec.ts — calendar buckets over a plain
// timestamp, an optional one, a `@db.column` rename and a nested document
// path; `region` / `meta.tier` exercise the one-null-group rule for plain
// `$groupBy` keys.

@db.table 'agg_bucket_events'
export interface AggBucketEvent {
    @meta.id
    id: number

    status: string

    openedAt: number.timestamp

    closedAt?: number.timestamp

    @db.column 'opened_on'
    renamedAt?: number.timestamp

    stats?: {
        firstSeenAt?: number.timestamp
    }

    region?: string

    meta?: {
        tier?: string
    }

    points: number
}
