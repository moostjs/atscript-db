// `$with` joins through keys the `$select` leaves out (since 0.1.143).

@db.table 'wj_users'
export interface WjUser {
    @meta.id
    id: number

    name: string
}

@db.table 'wj_tasks'
export interface WjTask {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    ownerId?: WjUser.id

    @db.rel.to
    owner?: WjUser

    @db.rel.from
    notes?: WjNote[]
}

@db.table 'wj_notes'
export interface WjNote {
    @meta.id
    id: number

    body: string

    @db.rel.FK
    taskId?: WjTask.id
}
