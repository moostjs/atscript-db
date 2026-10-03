// Live-server variant of `rel-filter.as` (server-gated `relation-filter.live.spec.ts`):
// the same domain without `@db.schema` (everything lives in the `relfix_*`
// database / schema the spec creates and drops) and without search / geo /
// vector indexes (not every container has the extensions). Adds `@db.column`
// renames on FK columns, referenced columns and primary keys.

@db.table 'rf_teams'
export interface RfTeam {
    @meta.id
    id: string

    name: string
}

@db.table 'rf_tickets'
export interface RfTicket {
    @meta.id
    key: string

    title: string

    @db.rel.FK
    @db.column 'team_ref'
    teamId?: RfTeam.id

    status: string

    @db.rel.FK 'parent'
    parentKey?: RfTicket.key

    @db.rel.to
    @db.rel.filterable
    team?: RfTeam

    @db.rel.to 'parent'
    @db.rel.filterable
    parent?: RfTicket

    @db.rel.from
    @db.rel.filterable
    issues?: RfIssue[]

    @db.rel.via RfTicketLabel
    @db.rel.filterable
    labels?: RfLabel[]
}

@db.table 'rf_issues'
export interface RfIssue {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    @db.column 'ticket_ref'
    ticketKey?: RfTicket.key

    @db.rel.to
    @db.rel.filterable
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

// Composite primary key with a renamed part; a self-referencing composite FK
// with a renamed local part referencing it.
@db.table 'rf_boards'
export interface RfBoard {
    @meta.id
    @db.column 'board_org'
    org: string

    @meta.id
    code: string

    title: string

    @db.rel.FK 'parentBoard'
    @db.column 'parent_org'
    parentOrg?: RfBoard.org

    @db.rel.FK 'parentBoard'
    parentCode?: RfBoard.code

    @db.rel.to 'parentBoard'
    @db.rel.filterable
    parentBoard?: RfBoard
}

@db.table 'rf_cards'
export interface RfCard {
    @meta.id
    id: number

    @db.rel.FK 'board'
    @db.column 'card_org'
    boardOrg?: RfBoard.org

    @db.rel.FK 'board'
    boardCode?: RfBoard.code

    @db.rel.to 'board'
    @db.rel.filterable
    board?: RfBoard
}

// A `@db.column`-renamed FK column (as-test case 16 shape)
@db.table 'rf_memos'
export interface RfMemo {
    @meta.id
    id: string

    @db.rel.FK
    @db.column 'ticket_ref'
    ticketKey?: RfTicket.key

    @db.rel.to
    @db.rel.filterable
    ticket?: RfTicket
}

// A `@db.column`-renamed primary key, referenced by a renamed FK column
// with a native ON DELETE CASCADE
@db.table 'rf_tags'
export interface RfTag {
    @meta.id
    @db.column 'tag_code'
    code: string

    label: string

    @db.rel.from
    @db.rel.filterable
    uses?: RfTagUse[]
}

@db.table 'rf_tag_uses'
export interface RfTagUse {
    @meta.id
    id: number

    @db.rel.FK
    @db.column 'tag_ref'
    @db.rel.onDelete 'cascade'
    tagCode?: RfTag.code

    note?: string

    @db.rel.to
    @db.rel.filterable
    tag?: RfTag
}
