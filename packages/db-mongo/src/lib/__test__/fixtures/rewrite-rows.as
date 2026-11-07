// `rewriteRowsStep` (since 0.1.175) on MongoDB: paged by `_id`.

@db.table 'rw_chats'
@db.mongo.collection
export interface RwChat {
    _id: mongo.objectId

    title: string

    @expect.maxLength 3
    turns: string[]
}
