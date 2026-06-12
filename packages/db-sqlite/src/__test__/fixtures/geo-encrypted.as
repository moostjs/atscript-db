@db.table 'geo_enc_places'
export interface GeoEncPlace {
    @meta.id
    id: string

    name: string

    @db.index.geo
    geo?: db.geoPoint

    @db.encrypted
    apiToken?: string

    @db.encrypted
    credentials?: {
        user: string
        pwd: string
    }
}
