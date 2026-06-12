@db.table 'geo_places'
export interface GeoPlace {
    @meta.id
    id: string

    name: string

    @db.index.geo
    geo?: db.geoPoint
}
