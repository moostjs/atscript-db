@db.table 'geo_listings'
export interface GeoListing {
    @meta.id
    id: string

    status: string

    @db.index.geo
    geo: db.geoPoint

    name?: string
}

@db.table 'enc_secrets'
export interface EncSecret {
    @meta.id
    id: string

    label: string

    @db.encrypted
    apiToken?: string

    @db.encrypted
    credentials?: {
        user: string
        pwd: string
    }
}
