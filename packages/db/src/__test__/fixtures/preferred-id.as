@db.table 'plain_users'
export interface PlainPreferredUser {
    @meta.id
    id: string

    email: string
}

@db.table 'email_users'
@db.table.preferredId.uniqueIndex
export interface EmailPreferredUser {
    @meta.id
    id: string

    @db.index.unique
    email: string

    @db.index.unique
    slug: string
}

@db.table 'slug_users'
@db.table.preferredId.uniqueIndex 'by_slug'
export interface SlugPreferredUser {
    @meta.id
    id: string

    @db.index.unique 'by_email'
    email: string

    @db.index.unique 'by_slug'
    slug: string
}

@db.table 'tenant_users'
@db.table.preferredId.uniqueIndex 'by_tenant_user'
export interface TenantPreferredUser {
    @meta.id
    id: string

    @db.index.unique 'by_tenant_user'
    tenantId: string

    @db.index.unique 'by_tenant_user'
    userId: string
}

@db.table 'physical_slug_users'
@db.table.preferredId.uniqueIndex
export interface PhysicalSlugPreferredUser {
    @meta.id
    id: string

    @db.column 'url_slug'
    @db.index.unique
    slug: string
}
