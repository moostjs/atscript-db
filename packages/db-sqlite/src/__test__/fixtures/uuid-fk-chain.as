@db.table 'uf_tenants'
export interface UfTenant {
    @meta.id
    @db.default.uuid
    id: string

    @db.index.unique 'uf_tenants_name'
    name: string

    @db.default.now
    createdAt: number.timestamp
}

@db.table 'uf_departments'
export interface UfDepartment {
    @meta.id
    @db.default.uuid
    id: string

    @db.rel.FK
    tenantId: UfTenant.id

    name: string
}

@db.table 'uf_members'
export interface UfMember {
    @meta.id
    @db.default.uuid
    id: string

    @db.rel.FK
    tenantId: UfTenant.id

    @db.rel.FK
    departmentId?: UfDepartment.id

    name: string
}
