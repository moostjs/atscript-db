@db.table 'vi_tasks'
export interface ViTask {
    @meta.id
    id: string

    title: string
    status: string
}

@db.view 'vi_task_list'
@db.view.for ViTask
export interface ViTaskList {
    id: ViTask.id
    title: ViTask.title

    @db.ignore
    computed?: string
}
