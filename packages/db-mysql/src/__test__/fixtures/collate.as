@db.table 'accounts'
export interface AccountTable {
    @meta.id
    @db.default.increment
    id: number

    @db.column.collate 'nocase'
    nickname: string

    email: string
}
