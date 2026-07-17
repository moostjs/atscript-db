@db.table 'oid-things'
@db.mongo.collection
export interface OidThing {
    _id: mongo.objectId

    ownerId: mongo.objectId

    tagIds?: mongo.objectId[]

    name: string

    nested?: {
        innerRef: mongo.objectId
    }
}
