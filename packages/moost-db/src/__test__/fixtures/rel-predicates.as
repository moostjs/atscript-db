// Fixture for relation-predicates.spec.ts — client relational predicates
// (`nav=$some(…)` / `nav=$none(…)`) over HTTP: opted-in (`@db.rel.filterable`)
// and opted-out relations, a related table with encrypted / write-only /
// JSON-derived fields, a manual-filter-mode related table, and a chain deep
// enough for the nesting cap (issue → ticket → team → tickets → issues).

@db.table 'rp_teams'
export interface RpTeam {
    @meta.id
    id: string

    name: string

    @db.rel.from
    @db.rel.filterable
    tickets?: RpTicket[]
}

@db.table 'rp_tickets'
export interface RpTicket {
    @meta.id
    key: string

    @db.rel.FK
    teamId?: RpTeam.id

    status: string

    @db.encrypted
    note?: string

    @db.writeOnly
    code?: string

    @db.json
    payload?: {
        region: string
    }

    @db.column.derived
    region?: RpTicket.payload.region

    @db.rel.to
    @db.rel.filterable
    team?: RpTeam

    @db.rel.from 'ticket'
    @db.rel.filterable
    issues?: RpIssue[]

    // Not opted in.
    @db.rel.from 'other'
    plainIssues?: RpIssue[]
}

// A related table in manual filter mode: only `title` is filterable.
@db.table 'rp_boards'
@db.table.filterable 'manual'
export interface RpBoard {
    @meta.id
    id: string

    @db.column.filterable
    title: string

    owner: string
}

@db.table 'rp_issues'
export interface RpIssue {
    @meta.id
    id: number

    title: string

    @db.rel.FK 'ticket'
    ticketKey?: RpTicket.key

    @db.rel.FK 'other'
    otherKey?: RpTicket.key

    @db.rel.FK 'board'
    boardId?: RpBoard.id

    @db.rel.to 'ticket'
    @db.rel.filterable
    ticket?: RpTicket

    // Not opted in.
    @db.rel.to 'other'
    ticketPlain?: RpTicket

    @db.rel.to 'board'
    @db.rel.filterable
    board?: RpBoard
}
