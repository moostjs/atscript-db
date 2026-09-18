// Views whose ONLY difference is a join condition, a filter target or a
// having predicate — the snapshot hash must tell them apart.

@db.table 'vh_users'
export interface VhUser {
    @meta.id
    @db.default.increment
    id: number

    name: string
    status: string
}

@db.table 'vh_tasks'
export interface VhTask {
    @meta.id
    @db.default.increment
    id: number

    title: string
    status: string
    amount: number

    @db.rel.FK
    assigneeId?: VhUser.id

    @db.rel.FK 'reporter'
    reporterId?: VhUser.id
}

@db.view 'vh_assigned'
@db.view.for VhTask
@db.view.joins VhUser, `VhUser.id = VhTask.assigneeId`
export interface VhJoinA {
    id: VhTask.id
    title: VhTask.title
    userName: VhUser.name
}

// Same tables, same columns — only the ON predicate differs
@db.view 'vh_assigned'
@db.view.for VhTask
@db.view.joins VhUser, `VhUser.id = VhTask.reporterId`
export interface VhJoinB {
    id: VhTask.id
    title: VhTask.title
    userName: VhUser.name
}

@db.view 'vh_active'
@db.view.for VhTask
@db.view.joins VhUser, `VhUser.id = VhTask.assigneeId`
@db.view.filter `VhTask.status = 'active'`
export interface VhFilterA {
    id: VhTask.id
    title: VhTask.title
}

// Same field name, other table — the filter now targets the joined table
@db.view 'vh_active'
@db.view.for VhTask
@db.view.joins VhUser, `VhUser.id = VhTask.assigneeId`
@db.view.filter `VhUser.status = 'active'`
export interface VhFilterB {
    id: VhTask.id
    title: VhTask.title
}

@db.view 'vh_totals'
@db.view.for VhTask
@db.view.having `total > 100`
export interface VhHavingA {
    status: VhTask.status

    @db.agg.sum "amount"
    total: number
}

@db.view 'vh_totals'
@db.view.for VhTask
@db.view.having `total > 500`
export interface VhHavingB {
    status: VhTask.status

    @db.agg.sum "amount"
    total: number
}

@db.view 'vh_plain'
@db.view.for VhTask
export interface VhPlain {
    id: VhTask.id
    title: VhTask.title

    @db.ignore
    computed?: string
}
