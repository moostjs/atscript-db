// Nested writes whose rows reference rows the same write creates, and keyed
// FROM children (natural string keys, a composite key holding the parent key).
@db.table 'wf_users'
@db.depth.limit 3
export interface WfUser {
    @meta.id
    id: string

    name?: string

    @db.rel.from 'owner'
    orders?: WfOrder[]

    @db.rel.via WfUserGroup
    groups?: WfGroup[]
}

@db.table 'wf_groups'
export interface WfGroup {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.FK
    createdBy?: WfUser.id
}

@db.table 'wf_user_groups'
export interface WfUserGroup {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    userId: WfUser.id

    @db.rel.FK
    groupId: WfGroup.id
}

@db.table 'wf_orders'
@db.depth.limit 2
export interface WfOrder {
    @meta.id
    code: string

    @db.rel.FK 'owner'
    ownerId?: WfUser.id

    label?: string

    @db.rel.from 'order'
    notes?: WfNote[]

    @db.rel.from 'lines'
    lines?: WfLine[]

    // Users watching the order (VIA back to the users table).
    @db.rel.via WfOrderWatcher
    watchers?: WfUser[]
}

@db.table 'wf_order_watchers'
export interface WfOrderWatcher {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    orderCode: WfOrder.code

    @db.rel.FK
    userId: WfUser.id
}

@db.table 'wf_notes'
export interface WfNote {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'order'
    orderCode?: WfOrder.code

    @db.rel.FK
    authorId?: WfUser.id

    text: string
}

// The parent's key is part of the child's composite key.
@db.table 'wf_lines'
export interface WfLine {
    @meta.id
    @db.rel.FK 'lines'
    orderCode: WfOrder.code

    @meta.id
    lineNo: number

    qty: number
}
