import { Task } from './rel-task'
import { Tag } from './rel-tag'

@db.table 'task_tags'
export interface TaskTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    taskId: Task.id

    @db.rel.FK
    tagId: Tag.id
}
