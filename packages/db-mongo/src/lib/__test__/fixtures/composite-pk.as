@db.table 'task_tags'
export interface TaskTag {
    @meta.id
    taskId: number

    @meta.id
    tagId: number

    @db.default.now
    assignedAt?: number
}
