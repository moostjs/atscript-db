@db.table 'simple'
@db.mongo.collection
export interface SimpleCollection {
    name: string
    active: boolean
    occupation?: string
    tags?: string[]
    age: number

    @db.patch.strategy 'replace'
    address: {
        line1: string
        line2?: string
        city: string
        state: string
        zip: string
    }

    @db.patch.strategy 'merge'
    contacts: {
        email: string
        phone: string
    }

    @db.patch.strategy 'merge'
    nested?: {
        @db.patch.strategy 'replace'
        nested1?: { a?: number, b?: string }

        @db.patch.strategy 'merge'
        nested2?: { c?: number, d?: string }
    }
}

@db.table 'minimal'
@db.mongo.collection
export interface MinimalCollection {
    name: string
}

@db.table 'minimal-string'
@db.mongo.collection
export interface MinimalCollectionString {
    _id: string
    name: string
}