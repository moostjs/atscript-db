@db.table
@db.mysql.engine "InnoDB"
@db.mysql.charset "utf8mb4"
@db.mysql.collate "utf8mb4_unicode_ci"
export interface MysqlSpecificTable {
    @meta.id
    @db.default.increment
    id: number

    @db.mysql.unsigned
    age: number.int

    @db.mysql.type "MEDIUMTEXT"
    bio: string

    @expect.maxLength 200
    name: string

    @db.mysql.onUpdate "CURRENT_TIMESTAMP"
    @db.default.now
    updatedAt: number.timestamp
}
