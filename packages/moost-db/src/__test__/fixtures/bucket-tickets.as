// Fixture for calendar-bucket-gate.spec.ts — a strict (dimension / measure)
// table with timestamp fields in every capability state, and a loose twin
// with a JSON-nested timestamp and an encrypted one.

@db.table 'bucket_tickets'
export interface BucketTicket {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    status: string

    @db.column.dimension
    openedAt: number.timestamp

    @db.column.dimension
    closedAt?: number.timestamp

    @db.default.now
    createdAt?: number.timestamp.created

    reviewedAt?: number.timestamp

    @db.column.measure
    points: number

    @db.writeOnly
    secretAt?: number.timestamp
}

@db.table 'bucket_loose'
export interface BucketLoose {
    @meta.id
    @db.default.increment
    id: number

    status: string

    openedAt: number.timestamp

    stats: {
        firstSeenAt: number.timestamp
    }

    @db.json
    meta: {
        seenAt: number.timestamp
    }

    @db.encrypted
    sealedAt?: number.timestamp

    points: number
}
