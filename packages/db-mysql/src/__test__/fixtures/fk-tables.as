@db.table 'projects'
export interface Project {
    @meta.id
    @db.default.increment
    id: number

    name: string
}

@db.table 'tasks'
export interface Task {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.FK
    projectId: Project.id

    @db.rel.FK 'reviewer'
    reviewerId?: Project.id
}
