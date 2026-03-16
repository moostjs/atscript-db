@db.table 'users'
@db.schema 'auth'
export interface UsersTable {
    @meta.id
    id: number

    @db.index.unique 'email_idx'
    @db.column 'email_address'
    email: string

    @db.index.plain 'name_idx'
    name: string

    @db.index.plain 'name_idx'
    @db.index.plain 'created_idx', 'desc'
    @db.default.now
    createdAt: number

    @db.ignore
    displayName?: string

    @db.default 'active'
    status: string

    @db.index.fulltext 'search_idx'
    bio?: string
}

@db.table 'profiles'
export interface ProfileTable {
    @meta.id
    @db.default.increment
    id: number

    name: string

    contact: {
        email: string
        phone?: string
    }

    @db.json
    preferences: {
        theme: string
        lang: string
    }

    tags: string[]

    settings: {
        notifications: {
            email: boolean
            sms: boolean
        }
    }

    @db.ignore
    displayName?: string
}

export interface NoTableAnnotation {
    name: string
}

@db.view 'active_users'
@db.view.for UsersTable
@db.view.filter `UsersTable.status = 'active'`
export interface ActiveUsersView {
    id: UsersTable.id
    name: UsersTable.name
    email: UsersTable.email
}

@db.view 'legacy_report'
export interface LegacyReportView {
    id: number
    total: number
}

@db.table 'app_users'
@db.table.renamed 'old_users'
export interface RenamedTable {
    @meta.id
    id: number
    name: string
    email: string
}

@db.view 'premium_users'
@db.view.renamed 'vip_users'
@db.view.for UsersTable
@db.view.filter `UsersTable.status = 'active'`
export interface RenamedView {
    id: UsersTable.id
    name: UsersTable.name
}
