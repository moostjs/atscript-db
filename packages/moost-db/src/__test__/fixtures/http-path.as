// Fixture for http-path-binding.spec.ts — value-help path publishing.

@db.table 'hp_tickets'
export interface HpTicket {
    @meta.id
    id: number

    @db.index.unique 'hp_ticket_key'
    key: string

    title: string

    // Self reference: the FK target is the canonical mount, not the request's mount
    @db.rel.FK
    parent?: HpTicket.id
}

@db.table 'hp_paths'
export interface HpPath {
    @meta.id
    id: number

    name: string
}

@db.table 'hp_memberships'
export interface HpMembership {
    @meta.id
    id: number

    @db.rel.FK
    ticket: HpTicket.key
}

@db.table 'hp_issues'
export interface HpIssue {
    @meta.id
    id: number

    // Reference chain ending at HpTicket.key (via HpMembership.ticket)
    activeTicketKey: HpMembership.ticket

    @db.rel.FK
    path?: HpPath.id
}

// Declares its own route hint
@db.table 'hp_docs'
@db.http.path 'hp-documents'
export interface HpDoc {
    @meta.id
    id: number

    title: string
}

@db.table 'hp_tags'
export interface HpTag {
    @meta.id
    id: number

    name: string
}

@db.table 'hp_tag_uses'
export interface HpTagUse {
    @meta.id
    id: number

    @db.rel.FK
    tag: HpTag.id
}

// Only mounted under parametric routes
@db.table 'hp_scoped'
export interface HpScoped {
    @meta.id
    id: number
}

export interface HpAction {
    note: string
}

// Display-only decoration whose field points at a served model
export interface HpTicketDecorations {
    @meta.label 'Related'
    @db.rel.FK
    related?: HpTicket.id
}
