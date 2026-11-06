// A referenced column whose type changes when its last reference goes away
// (schema-sync.spec.ts, "inbound FKs over a retyped column").

@db.table 'rk_cats'
export interface RkCat {
    @meta.id
    id: number

    @db.index.unique 'rk_slug_idx'
    slug: string
}

@db.table 'rk_refs'
export interface RkArtRef {
    @meta.id
    id: number

    @db.rel.FK
    catSlug?: RkCat.slug
}

// The same table without the foreign key
@db.table 'rk_refs'
export interface RkArtPlain {
    @meta.id
    id: number

    catSlug?: string
}
