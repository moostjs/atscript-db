// Fixture for calendar-buckets.spec.ts — epoch-ms timestamps (`openedAt`,
// `closedAt`) and a `@db.default.now` one (`createdAt`, a different storage
// kind on some engines).
@db.table 'bucket_tickets'
export interface BucketTicket {
    @meta.id
    @db.default.increment
    id: number

    status: string

    openedAt: number.timestamp

    closedAt?: number.timestamp

    @db.default.now
    createdAt?: number.timestamp.created
}
