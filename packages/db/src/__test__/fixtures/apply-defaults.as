// Fixture for apply-defaults.spec.ts: one static default per design type
// (string literal union, boolean, number, JSON object), plus one native-able
// function default (`now`) and one that is always SDK-side on the mock (`uuid`).
@db.table 'default_items'
export interface DefaultItem {
    @meta.id
    id: number

    name: string

    @db.default 'todo'
    status: 'todo' | 'done'

    @db.default 'false'
    archived: boolean

    @db.default '0'
    score?: number

    @db.json
    @db.default '{"theme":"light"}'
    prefs?: {
        theme: string
    }

    @db.default.now
    createdAt?: number.timestamp.created

    @db.default.uuid
    token?: string
}
