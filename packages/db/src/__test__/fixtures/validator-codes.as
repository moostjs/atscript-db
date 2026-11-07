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

// A @db.json array: written whole, so array patch operators are ARRAY_OP_ON_JSON.
@db.table 'vc_docs'
export interface VcDoc {
    @meta.id
    id: number

    @db.json
    tags: string[]

    labels: string[]
}
