@db.table 'password_docs'
export interface PasswordDocFixture {
    @meta.id
    @db.default.increment
    id: number

    label: string

    @db.column.version
    version: number.int

    @db.patch.strategy 'merge'
    password: {
        hash: string
        history: string[]
        lastChanged: number
        isInitial: boolean
    }
}
