@db.table 'users'
@db.schema 'auth'
export interface UsersTable {
    @meta.id
    @db.default.increment
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
