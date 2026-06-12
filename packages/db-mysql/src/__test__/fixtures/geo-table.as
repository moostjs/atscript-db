@db.table 'geo_places'
export interface GeoPlace {
    @meta.id
    id: string

    name: string

    @db.index.geo
    geo: db.geoPoint
}

@db.table 'geo_places_opt'
export interface GeoPlaceOpt {
    @meta.id
    id: string

    @db.index.geo
    geo?: db.geoPoint
}
