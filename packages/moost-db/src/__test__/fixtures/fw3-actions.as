// Fixtures for the 0.1.147 action specs: candidate-aware actionRowScope,
// @DbActionsFrom (view → source delegation) and query targets.
// Domain: Issue → Ticket (team, status); IssueBoard = a view over both.

@db.table 'fw3_tickets'
export interface FwTicket {
    @meta.id
    key: string

    teamId: string

    status: string
}

@db.table 'fw3_issues'
export interface FwIssue {
    @meta.id
    id: number

    @db.rel.FK
    ticketKey: FwTicket.key

    status: string

    @db.column.searchable
    title: string

    secret?: string
}

// A denormalized board table standing in for a view at runtime (memory
// views hold no rows): `issueId` names the source issue, null = no issue.
@db.table 'fw3_board'
export interface FwBoardRow {
    @meta.id
    rowId: number

    issueId?: number

    ticketKey: string

    title: string

    teamId: string
}

// Issue lines with a composite key, and a board addressing them.
@db.table 'fw3_lines'
export interface FwLine {
    @meta.id
    issueId: number

    @meta.id
    lineNo: number

    status: string
}

@db.table 'fw3_line_board'
export interface FwLineBoardRow {
    @meta.id
    rowId: number

    issue: number

    line: number
}

// The real view: `id` derives the delegation's id map.
@db.view 'fw3_issue_board'
@db.view.for FwIssue
@db.view.joins FwTicket, `FwTicket.key = FwIssue.ticketKey`
export interface FwIssueBoard {
    id: FwIssue.id
    title: FwIssue.title
    status: FwIssue.status
    teamId: FwTicket.teamId
}

// Renamed: the issue id is `issueId` here.
@db.view 'fw3_issue_board_renamed'
@db.view.for FwIssue
export interface FwIssueBoardRenamed {
    issueId: FwIssue.id
    title: FwIssue.title
}

// Ambiguous: two plain columns map the issue id.
@db.view 'fw3_issue_board_twice'
@db.view.for FwIssue
export interface FwIssueBoardTwice {
    id: FwIssue.id
    alsoId: FwIssue.id
}

// Aggregate: the issue id is only aggregated — not a row identity.
@db.view 'fw3_team_counts'
@db.view.for FwIssue
@db.view.joins FwTicket, `FwTicket.key = FwIssue.ticketKey`
export interface FwTeamCounts {
    teamId: FwTicket.teamId

    @db.agg.max "id"
    lastIssue: number
}
