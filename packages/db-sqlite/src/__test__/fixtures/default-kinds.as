// Every kind of column default schema sync compares (canonical, type-aware):
// a forced re-sync of a converged table must find nothing to alter.
@db.table 'dk_defaults'
export interface DkDefaults {
    @meta.id
    id: number

    @db.default '1.0'
    ratio: number

    @db.default '-1'
    rank: number.int

    @db.default '5'
    cap: number

    @db.default 'true'
    active: boolean

    @db.default 'false'
    archived: boolean

    @db.default '10.50'
    price: decimal

    @db.default '0'
    balance: decimal

    @db.column.precision 10, 2
    @db.default '2.345'
    fee: decimal

    @db.default "it's"
    note: string

    @db.default 'x'
    label?: string

    @db.default 'a'
    tier: 'a' | 'b'

    @db.default '{"b":2,"a":1}'
    @db.json
    meta: { a: number, b: number }

    @db.default '[]'
    tags: string[]

    @expect.maxLength 20
    @db.default 'v'
    code: string

    @db.default "a\\b 'q' \"d\" ü 😀 %_"
    tricky: string

    @db.default '{"k":"a\\b ü 😀 %_","n":[2,1]}'
    @db.json
    trickyJson: { k: string, n: number[] }

    @db.default.now
    createdAt: number.timestamp

    @db.column.version
    version: number.int
}

@db.table 'dk_teams'
export interface DkTeam {
    @meta.id
    id: number

    name: string
}

@db.table 'dk_members'
export interface DkMember {
    @meta.id
    id: number

    @db.rel.FK
    teamId: DkTeam.id
}

// `dk_members` before its FK was declared
@db.table 'dk_members'
export interface DkMemberNoFk {
    @meta.id
    id: number

    teamId: number
}

// Every index kind (plain, unique, composite with a sort order, fulltext,
// geo, a unique index over an optional field): a forced re-sync must not
// report index work for a converged table.
@db.table 'dk_indexed'
export interface DkIndexed {
    @meta.id
    id: number

    @db.index.plain 'by_title'
    @db.index.fulltext 'dk_search'
    title: string

    @db.index.fulltext 'dk_search'
    body: string

    @expect.maxLength 40
    @db.index.unique
    code: string

    @db.index.unique 'by_email'
    email?: string

    @db.index.plain 'by_team_rank', 'desc'
    teamId: number

    @db.index.plain 'by_team_rank'
    rank: number

    @db.index.geo
    spot: db.geoPoint

    @db.index.geo
    spotOpt?: db.geoPoint
}

// `dk_indexed` after an index change: `by_title` removed, `by_team_rank`
// gained `code` as its first member, `by_rank` added.
@db.table 'dk_indexed'
export interface DkIndexedV2 {
    @meta.id
    id: number

    @db.index.fulltext 'dk_search'
    title: string

    @db.index.fulltext 'dk_search'
    body: string

    @expect.maxLength 40
    @db.index.unique
    @db.index.plain 'by_team_rank'
    code: string

    @db.index.unique 'by_email'
    email?: string

    @db.index.plain 'by_team_rank', 'desc'
    teamId: number

    @db.index.plain 'by_team_rank'
    @db.index.plain 'by_rank'
    rank: number

    @db.index.geo
    spot: db.geoPoint

    @db.index.geo
    spotOpt?: db.geoPoint
}
