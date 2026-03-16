@db.table 'tags'
export interface Tag {
    @meta.id
    @db.default.increment
    id: number

    name: string
}
