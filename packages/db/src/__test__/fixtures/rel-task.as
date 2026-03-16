import { Tag } from './rel-tag'
import { TaskTag } from './rel-task-tag'

@db.table 'tasks'
export interface Task {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.via TaskTag
    tags?: Tag[]
}
