// Fixture for recreate-server.spec.ts — `@db.sync.method 'recreate'` rebuilds
// the collection with its current options (here: capped) and keeps the data.

@db.table 'recreate_logs'
@db.mongo.capped 1048576, 100
export interface RecreateLog {
    @meta.id
    id: number

    message: string
}
