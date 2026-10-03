// Foreign keys over `@db.column`-renamed columns: a renamed local FK column,
// a renamed referenced (target) column, a composite FK mixing both, and a
// plain FK whose schema hash must not change.

@db.table 'rk_teams'
export interface RkTeam {
    @meta.id
    id: string

    name: string
}

@db.table 'rk_tags'
export interface RkTag {
    @meta.id
    @db.column 'tag_code'
    code: string

    label: string
}

@db.table 'rk_boards'
export interface RkBoard {
    @meta.id
    @db.column 'board_org'
    org: string

    @meta.id
    code: string

    title: string
}

@db.table 'rk_plain'
export interface RkPlain {
    @meta.id
    id: number

    @db.rel.FK
    teamId?: RkTeam.id

    @db.rel.to
    team?: RkTeam
}

@db.table 'rk_items'
export interface RkItem {
    @meta.id
    id: number

    @db.rel.FK
    @db.column 'team_ref'
    teamId?: RkTeam.id

    @db.rel.FK
    tagCode?: RkTag.code

    @db.rel.FK 'board'
    @db.column 'b_org'
    boardOrg?: RkBoard.org

    @db.rel.FK 'board'
    boardCode?: RkBoard.code

    @db.rel.to
    team?: RkTeam

    @db.rel.to
    tag?: RkTag

    @db.rel.to 'board'
    board?: RkBoard
}
