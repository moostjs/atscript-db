// Relational predicates vs per-field collation on MongoDB: a predicate pipeline runs
// without an operation-wide collation — each table's `nocase` fields compare
// case-insensitively, join keys and binary fields byte-wise.

@db.table 'rc_teams'
export interface RcTeam {
    @meta.id
    id: string

    @db.column.collate 'nocase'
    name: string

    @db.rel.from
    members?: RcMember[]
}

@db.table 'rc_members'
export interface RcMember {
    @meta.id
    id: number

    @db.rel.FK
    teamId?: RcTeam.id

    @db.column.collate 'nocase'
    nick: string

    role: string

    @db.column.collate 'unicode'
    city?: string

    @db.rel.to
    team?: RcTeam
}
