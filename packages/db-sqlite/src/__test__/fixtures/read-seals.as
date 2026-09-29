// Geo / vector search honour $select (incl. the write-only seal, an exclusion
// projection) and views inherit read seals (read-seals.spec.ts). Since 0.1.143.

@db.table 'rs_places'
export interface RsPlace {
    @meta.id
    id: string

    name: string

    @db.writeOnly
    pin?: string

    @db.encrypted
    token?: string

    settings: {
        theme: string
        apiKey: string
    }

    @db.index.geo
    geo?: db.geoPoint
}

@db.table 'rs_docs'
@db.depth.limit 0
export interface RsDoc {
    @meta.id
    id: string

    title: string

    @db.writeOnly
    pin?: string

    @db.search.filter "embedding"
    category: string

    @db.search.vector 256, "cosine"
    embedding: number[]
}

@db.view 'rs_place_view'
@db.view.for RsPlace
export interface RsPlaceView {
    id: RsPlace.id
    name: RsPlace.name
    pin?: RsPlace.pin
    token?: RsPlace.token
}
