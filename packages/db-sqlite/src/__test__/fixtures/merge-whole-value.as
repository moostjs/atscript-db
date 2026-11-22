// Fixture for the shared merge-whole-value cases (since 0.1.184): one type
// with a merge-strategy field, placed where a patch reaches it by its own
// path (`prefs`) and where it is written as part of a whole value. The types
// are referenced, so the build accepts every placement: it checks the
// annotation where it is written.

export interface MwvGeo {
    lat: number
    lng: number
    note?: string
}

export interface MwvPrefs {
    label?: string

    @db.patch.strategy 'merge'
    geo?: MwvGeo
}

export interface MwvLine {
    @expect.array.key
    k: string

    note?: string

    @db.patch.strategy 'merge'
    geo?: MwvGeo
}

export interface MwvOther {
    other: string
}

export interface MwvNested {
    tag?: string
    inner?: MwvPrefs | null
}

@db.table 'mwv_items'
export interface MwvItem {
    @meta.id
    id: number

    @db.patch.strategy 'merge'
    prefs?: MwvPrefs

    @db.patch.strategy 'merge'
    lines?: MwvLine[]

    @db.json
    jprefs?: MwvPrefs

    @db.encrypted
    eprefs?: MwvPrefs

    mixed?: MwvPrefs | string

    union?: MwvPrefs | MwvOther

    pair?: [MwvPrefs, number]

    @db.json
    jset?: {
        a?: string
        b?: string
    }

    @db.encrypted
    eset?: {
        a?: string
        b?: string
    }

    // a `T | null` is a `T`: merge applies through it and on it
    x?: {
        name?: string
        @db.patch.strategy 'merge'
        g?: {
            a: number
            b: number
        }
    } | null

    np?: MwvPrefs | null

    @db.patch.strategy 'merge'
    mnp?: MwvPrefs | null

    outer?: MwvNested

    @db.patch.strategy 'merge'
    mouter?: MwvNested

    @db.column 'rlines'
    @db.patch.strategy 'merge'
    renamedLines?: MwvLine[]
}
