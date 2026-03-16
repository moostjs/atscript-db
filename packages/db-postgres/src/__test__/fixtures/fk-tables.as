@db.table 'projects'
export interface Project {
    @meta.id
    id: number

    name: string
}

@db.table 'tasks'
export interface Task {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    projectId: Project.id

    @db.rel.FK 'reviewer'
    reviewerId?: Project.id
}
