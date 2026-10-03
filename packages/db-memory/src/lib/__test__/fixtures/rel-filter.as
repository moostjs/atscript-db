// Relational filter predicates ($some / $none) — generic Issue / Ticket / Team domain.

@db.table 'rf_teams'
export interface RfTeam {
    @meta.id
    id: string

    name: string

    @db.rel.from
    @db.rel.filter `RfTicket.status = 'open'`
    openTickets?: RfTicket[]
}

@db.table 'rf_tickets'
export interface RfTicket {
    @meta.id
    key: string

    @db.rel.FK
    @db.column 'team_ref'
    teamId?: RfTeam.id

    status: string

    @db.rel.FK 'parent'
    parentKey?: RfTicket.key

    @db.rel.to
    team?: RfTeam

    @db.rel.to 'parent'
    parent?: RfTicket

    @db.rel.from
    issues?: RfIssue[]

    @db.rel.via RfTicketLabel
    labels?: RfLabel[]

    @db.rel.via RfTicketLabel
    @db.rel.filter `RfTicketLabel.pinned = true and RfLabel.name != 'hidden'`
    pinnedLabels?: RfLabel[]
}

@db.table 'rf_issues'
export interface RfIssue {
    @meta.id
    id: number

    title: string

    points?: number

    @db.rel.FK
    @db.column 'ticket_ref'
    ticketKey?: RfTicket.key

    @db.rel.to
    ticket?: RfTicket
}

@db.table 'rf_labels'
export interface RfLabel {
    @meta.id
    id: number

    @db.column 'label_name'
    name: string
}

@db.table 'rf_ticket_labels'
export interface RfTicketLabel {
    @meta.id
    id: number

    @db.rel.FK
    ticketKey: RfTicket.key

    @db.rel.FK
    labelId: RfLabel.id

    pinned?: boolean
}

@db.table 'rf_boards'
export interface RfBoard {
    @meta.id
    org: string

    @meta.id
    code: string

    title: string
}

@db.table 'rf_cards'
export interface RfCard {
    @meta.id
    id: number

    @db.rel.FK 'board'
    boardOrg?: RfBoard.org

    @db.rel.FK 'board'
    boardCode?: RfBoard.code

    @db.rel.to 'board'
    board?: RfBoard
}
