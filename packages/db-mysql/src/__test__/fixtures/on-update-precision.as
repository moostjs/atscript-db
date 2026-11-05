// `@db.mysql.onUpdate` with a precision, a renamed column and a flattened
// nested field; `@db.mysql.engine` / `charset` outside the completion list.
@db.table 'ou_events'
@db.mysql.engine "innodb"
@db.mysql.charset "utf8mb3"
export interface OuEvent {
    @meta.id
    id: number

    @db.mysql.type "TIMESTAMP(3)"
    @db.default.now
    @db.mysql.onUpdate "CURRENT_TIMESTAMP(3)"
    changedAt: number.timestamp

    @db.mysql.type "DATETIME(6)"
    @db.mysql.onUpdate "NOW()"
    touchedAt?: number.timestamp

    @db.column "updated_at"
    @db.default.now
    @db.mysql.onUpdate "CURRENT_TIMESTAMP"
    updatedAt: number.timestamp

    audit: {
        @db.default.now
        @db.mysql.onUpdate "CURRENT_TIMESTAMP"
        at: number.timestamp
    }
}
