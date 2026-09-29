// Geo / vector search honour $select (search-select.spec.ts). Since 0.1.143.

@db.table 'ss_places'
export interface SsPlace {
    @meta.id
    id: string

    name: string

    @db.writeOnly
    pin?: string

    settings: {
        theme: string
        apiKey: string
    }

    @db.index.geo
    geo: db.geoPoint
}

@db.table 'ss_docs'
export interface SsDoc {
    @meta.id
    id: string

    title: string

    @db.writeOnly
    pin?: string

    @db.search.vector 256, "cosine"
    embedding: number[]
}
