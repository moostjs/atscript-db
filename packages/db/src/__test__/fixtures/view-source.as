// Views over flattened, renamed and JSON-stored source columns — the view
// must read PHYSICAL source names (view-mappings.spec.ts, schema-hash.spec.ts).

@db.table 'vs_users'
export interface VsUser {
    @meta.id
    id: number

    @db.column 'first_name'
    firstName: string

    address: {
        city: string

        @db.column 'zip_code'
        zip: string

        geo: {
            lat: number
        }
    }

    @db.json
    settings: {
        theme: string
        size: number
        dark: boolean
        inner: {
            mode: string
        }
    }

    tags: string[]

    regionId?: number
}

@db.table 'vs_regions'
export interface VsRegion {
    @meta.id
    id: number

    @db.column 'region_name'
    name: string

    countryId?: number
}

@db.table 'vs_countries'
export interface VsCountry {
    @meta.id
    id: number

    name: string
}

@db.view 'vs_user_view'
@db.view.for VsUser
@db.view.filter `VsUser.address.city = 'Paris'`
export interface VsUserView {
    id: VsUser.id
    firstName: VsUser.firstName
    city: VsUser.address.city
    zip: VsUser.address.zip

    @db.column 'lat_view'
    lat: VsUser.address.geo.lat

    theme: VsUser.settings.theme
    size: VsUser.settings.size
    dark: VsUser.settings.dark
    mode: VsUser.settings.inner.mode
    address: VsUser.address

    @db.json
    settings: VsUser.settings

    tags: VsUser.tags
}

// Object field over a JSON column without @db.json on the view field
@db.view 'vs_bad_json'
@db.view.for VsUser
export interface VsBadJsonObject {
    id: VsUser.id
    settings: VsUser.settings
}

@db.view 'vs_chain'
@db.view.for VsUser
@db.view.joins VsRegion, `VsRegion.id = VsUser.regionId`, 'left'
@db.view.joins VsCountry, `VsCountry.id = VsRegion.countryId`
export interface VsChain {
    id: VsUser.id
    regionName?: VsRegion.name
    countryName: VsCountry.name
}

@db.view 'vs_region_stats'
@db.view.for VsUser
@db.view.joins VsRegion, `VsRegion.id = VsUser.regionId`
@db.view.having `users > 1`
export interface VsRegionStats {
    city: VsUser.address.city

    @db.agg.count
    users: number

    @db.agg.sum "address.geo.lat"
    latSum: number
}

// Layout parity with TableMetadata beyond column names: JSON roots (arrays
// and @db.json inside a JSON column are part of it), encrypted subtrees,
// @db.ignore and navigation relations (whose target annotations must not leak).
@db.table 'vs_parity'
export interface VsParity {
    @meta.id
    id: number

    @db.column 'nick_name'
    nick?: string

    @db.ignore
    computed?: string

    @db.encrypted
    secret?: {
        user: string
        pass: string
    }

    @db.json
    prefs?: {
        tags: string[]
        @db.json
        deep: {
            a: number
        }
        items: {
            name: string
        }[]
    }

    list: {
        label: string
        @db.column 'val'
        value: number
    }[]

    meta?: {
        @db.column 'the_kind'
        kind: string
        sub?: {
            flag: boolean
        }
    }

    @db.rel.FK
    regionId?: VsRegion.id

    @db.rel.to
    region?: VsRegion
}
