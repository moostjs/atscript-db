// Fixture for meta-merge-paths.spec.ts (since 0.1.184): a merge-strategy
// type placed where a patch reaches it by its own path and where it does not.

export interface MpmPrefs {
    label?: string

    @db.patch.strategy 'merge'
    geo?: {
        lat: number
        lng: number
    }
}

@db.table 'mpm_items'
export interface MpmItem {
    @meta.id
    id: number

    @db.patch.strategy 'merge'
    prefs?: MpmPrefs

    maybe?: MpmPrefs | null

    @db.json
    jprefs?: MpmPrefs

    @db.encrypted
    eprefs?: MpmPrefs

    list?: MpmPrefs[]

    union?: MpmPrefs | string

    pair?: [MpmPrefs, number]
}
