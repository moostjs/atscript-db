@db.table 'geo_listings'
export interface GeoListing {
    @meta.id
    id: string

    status: string

    @db.index.geo
    geo: db.geoPoint

    @db.index.geo 'second'
    altGeo?: db.geoPoint

    name?: string
}

@db.table 'geo_unindexed'
export interface GeoUnindexed {
    @meta.id
    id: string

    point?: db.geoPoint
}
