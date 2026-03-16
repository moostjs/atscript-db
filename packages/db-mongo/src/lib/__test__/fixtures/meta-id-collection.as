@db.table 'todos'
@db.mongo.collection
export interface TodoCollection {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.default 'false'
    completed: boolean
}

@db.table 'items'
@db.mongo.collection
export interface ItemCollection {
    @meta.id
    code: string

    name: string
}
