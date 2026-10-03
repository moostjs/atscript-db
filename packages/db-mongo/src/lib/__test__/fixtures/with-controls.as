// `$with` per-relation controls (`$sort` / `$skip` / `$limit`) apply to the
// related rows of EACH parent row (since 0.1.147). TO / FROM / VIA relations,
// single and composite (TO / FROM) keys, `@db.column`-renamed join and sort
// columns.

@db.table 'ws_tickets'
export interface WsTicket {
    @meta.id
    @db.column 'ticket_key'
    key: string

    title: string

    @db.rel.from
    issues?: WsIssue[]

    @db.rel.via WsTicketLabel
    labels?: WsLabel[]
}

@db.table 'ws_issues'
export interface WsIssue {
    @meta.id
    id: number

    title: string

    @db.column 'sev'
    severity: number

    @db.rel.FK
    @db.column 'ticket_ref'
    ticketKey?: WsTicket.key

    @db.rel.to
    ticket?: WsTicket
}

@db.table 'ws_labels'
export interface WsLabel {
    @meta.id
    id: number

    @db.column 'label_name'
    name: string
}

@db.table 'ws_ticket_labels'
export interface WsTicketLabel {
    @meta.id
    id: number

    @db.rel.FK
    @db.column 'ticket_ref'
    ticketKey: WsTicket.key

    @db.rel.FK
    labelId: WsLabel.id
}

// Composite primary key with a renamed part: composite FROM and TO.
@db.table 'ws_boards'
export interface WsBoard {
    @meta.id
    @db.column 'board_org'
    org: string

    @meta.id
    code: string

    title: string

    @db.rel.from 'board'
    cards?: WsCard[]
}

@db.table 'ws_cards'
export interface WsCard {
    @meta.id
    id: number

    @db.column 'card_rank'
    rank: number

    @db.rel.FK 'board'
    @db.column 'card_org'
    boardOrg: WsBoard.org

    @db.rel.FK 'board'
    boardCode: WsBoard.code

    @db.rel.to 'board'
    board?: WsBoard
}
