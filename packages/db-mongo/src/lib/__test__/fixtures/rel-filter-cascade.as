// Application-level cascades under a relational-predicate delete filter / scope on
// MongoDB: the matched parents are pinned before their children are cascaded.

@db.table 'rd_tickets'
export interface RdTicket {
    @meta.id
    key: string

    status: string

    @db.rel.from
    issues?: RdIssue[]

    @db.rel.from
    notes?: RdNote[]
}

@db.table 'rd_issues'
export interface RdIssue {
    @meta.id
    id: number

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    ticketKey?: RdTicket.key

    title: string

    @db.rel.to
    ticket?: RdTicket
}

@db.table 'rd_notes'
export interface RdNote {
    @meta.id
    id: number

    @db.rel.FK
    @db.rel.onDelete 'setNull'
    ticketKey?: RdTicket.key

    @db.rel.to
    ticket?: RdTicket
}

// ObjectId primary key on the parent.
@db.table 'rd_projects'
@db.mongo.collection
export interface RdProject {
    @meta.id
    _id: mongo.objectId

    name: string

    @db.rel.from
    tasks?: RdTask[]
}

@db.table 'rd_tasks'
export interface RdTask {
    @meta.id
    id: number

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    projectId?: RdProject._id

    title: string

    @db.rel.to
    project?: RdProject
}
