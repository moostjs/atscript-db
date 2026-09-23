// Fixture for calendar-bucket.spec.ts — `number.timestamp` bucket sources
// (required and optional) beside a plain dimension and a measure.

@db.table 'bucket_events'
export interface BucketEvent {
    @meta.id
    id: number

    region: string

    amount?: number

    openedAt: number.timestamp

    closedAt?: number.timestamp
}
