// Fixture for calendar-buckets.spec.ts — timestamp fields in every storage
// shape the bucket guard / mappers distinguish: a plain column, an optional
// one, a `@db.column` rename, a flattened leaf, a JSON descendant, an
// encrypted one; plus non-timestamp numbers, a navigation relation (alias
// collision) and a strict (dimension / measure) twin.

@db.table 'bucket_owners'
export interface BucketOwner {
    @meta.id
    id: number

    name: string
}

@db.table 'bucket_events'
export interface BucketEvent {
    @meta.id
    @db.default.increment
    id: number

    status: string

    openedAt: number.timestamp

    closedAt?: number.timestamp

    @db.default.now
    createdAt?: number.timestamp.created

    @db.column 'opened_on'
    renamedAt: number.timestamp

    points: number

    stats: {
        firstSeenAt: number.timestamp
    }

    @db.json
    meta: {
        seenAt: number.timestamp
    }

    @db.encrypted
    secretAt?: number.timestamp

    @db.rel.FK
    ownerId: BucketOwner.id

    @db.rel.to
    owner?: BucketOwner
}

@db.table 'bucket_strict'
export interface BucketStrict {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    status: string

    @db.column.dimension
    openedAt: number.timestamp

    reviewedAt?: number.timestamp

    @db.column.measure
    points: number
}
