// Fixture for view-missing-server.spec.ts — view columns whose source is
// missing on the document (an absent key, an absent JSON leaf) read as null,
// like SQL. Since 0.1.136.

@db.table 'vm_users'
export interface VmUser {
    @meta.id
    id: number

    nickname?: string

    @db.json
    settings?: {
        theme?: string
        fontSize?: number
    }
}

@db.view 'vm_user_prefs'
@db.view.for VmUser
export interface VmUserPrefs {
    id: VmUser.id
    nickname?: VmUser.nickname
    theme?: VmUser.settings.theme
    fontSize?: VmUser.settings.fontSize
}

@db.view 'vm_theme_counts'
@db.view.for VmUser
export interface VmThemeCounts {
    theme?: VmUser.settings.theme

    @db.agg.count
    users: number
}
