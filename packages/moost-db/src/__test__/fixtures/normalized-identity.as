// The "unique index over a custom-normalised value" recipe
// (normalized-identity.spec.ts): a stored column the controller fills.

@db.table 'ni_items'
export interface NiItem {
    @meta.id
    id: number

    name: string

    catalog: string

    @db.index.unique 'item_identity'
    identity?: string
}
