// Fixtures for security-gates.spec.ts (0.1.143): joined-row write-only seal,
// derived-column visibility, text / vector / geo index gating and the
// PK-first 409 disambiguation.

@db.table 'sg_orgs'
export interface SgOrg {
    @meta.id
    id: number

    name: string

    @db.writeOnly
    apiToken?: string
}

@db.table 'sg_users'
export interface SgUser {
    @meta.id
    id: number

    name: string

    @db.writeOnly
    password?: string

    @db.rel.FK
    orgId?: SgOrg.id

    @db.rel.to
    org?: SgOrg
}

@db.table 'sg_tasks'
export interface SgTask {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    ownerId?: SgUser.id

    @db.rel.to
    owner?: SgUser
}

@db.table 'sg_accounts'
export interface SgAccount {
    @meta.id
    id: number

    @db.index.fulltext 'txt_idx'
    @db.column.searchable
    title: string

    @db.index.fulltext 'txt_idx'
    secretNote: string

    @db.index.fulltext 'note_idx'
    note: string

    @db.search.vector 256, "cosine"
    embedding?: number[]

    @db.index.geo
    home?: db.geoPoint

    @db.json
    settings: {
        apiKey: string
        theme: string
    }

    @db.column.derived
    apiKeyCopy?: SgAccount.settings.apiKey
}

@db.table 'sg_slugs'
export interface SgSlug {
    @meta.id
    id: string

    @db.index.unique 'slug_idx'
    slug: string

    title: string

    @db.column.version
    version: number.int
}
