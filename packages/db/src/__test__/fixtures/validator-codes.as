// A 1:1 FROM relation (db-validator-codes.spec.ts): patch operators on it are rejected.

@db.table 'vc_parents'
export interface VcParent {
    @meta.id
    id: number

    @db.rel.from
    profile?: VcProfile
}

@db.table 'vc_profiles'
export interface VcProfile {
    @meta.id
    id: number

    @db.rel.FK
    parentId: VcParent.id
}
