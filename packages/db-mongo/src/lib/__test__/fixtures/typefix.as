// Filter values checked against the column type (typefix specs, since
// 0.1.147). The same fixture is shared by every adapter package.

@db.table 'tf_tickets'
export interface TfTicket {
    @meta.id
    id: number

    title: string

    @db.rel.from
    @db.rel.filterable
    issues?: TfIssue[]
}

@db.table 'tf_issues'
export interface TfIssue {
    @meta.id
    id: number

    @db.rel.FK
    ticketId: TfTicket.id

    n: number

    ts: number.timestamp

    flag: boolean

    label: string

    price: decimal

    @db.rel.to
    ticket?: TfTicket
}

@db.view 'tf_ticket_stats'
@db.view.for TfTicket
@db.view.joins TfIssue, `TfIssue.ticketId = TfTicket.id`, 'left'
export interface TfTicketStats {
    id: TfTicket.id
    title: TfTicket.title

    @db.agg.count 'id'
    issueCount: TfIssue.id

    @db.agg.sum 'n'
    total?: TfIssue.n

    @db.compute `issueCount * 10`
    rank: number
}
