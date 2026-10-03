// Relational predicates + application-level cascades (memory has no native
// FKs): the delete must target the rows the cascade ran for, by key.

@db.table 'rc_tickets'
export interface RcTicket {
    @meta.id
    key: string

    status: string

    @db.rel.from
    @db.rel.filterable
    issues?: RcIssue[]

    @db.rel.from
    @db.rel.filterable
    notes?: RcNote[]
}

@db.table 'rc_issues'
export interface RcIssue {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    ticketKey?: RcTicket.key

    @db.rel.to
    ticket?: RcTicket
}

@db.table 'rc_notes'
export interface RcNote {
    @meta.id
    id: number

    body: string

    @db.rel.FK
    @db.rel.onDelete 'setNull'
    ticketKey?: RcTicket.key

    @db.rel.to
    ticket?: RcTicket
}
