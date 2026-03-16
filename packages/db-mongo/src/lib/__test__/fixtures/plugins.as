@db.table 'IdPlugin'
@db.mongo.collection
export interface IdPlugin {
    _id: mongo.objectId
}

@db.table 'UniqueItems'
@db.mongo.collection
export interface UniqueItems {
    str?: string[]

    @expect.array.uniqueItems
    strUnique?: string[]

    obj?: {
        a: string
        b: string
    }[]

    @expect.array.uniqueItems
    objUnique?: {
        a: string
        b: string
    }[]

    @expect.array.uniqueItems
    kObj?: {
        @expect.array.key
        a: string
        b: string
    }[]
}