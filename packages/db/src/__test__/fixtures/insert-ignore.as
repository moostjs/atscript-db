// Conflict-ignoring insert (insert-ignore.spec.ts). Since 0.1.148.

@db.table 'ig_orgs'
export interface IgOrg {
    @meta.id
    id: number

    name: string
}

@db.table 'ig_items'
@db.depth.limit 2
export interface IgItem {
    @meta.id
    id: number

    @db.index.unique 'sku_idx'
    sku: string

    @db.index.unique 'pair_idx'
    pairA?: string

    @db.index.unique 'pair_idx'
    pairB?: string

    qty: number

    @db.rel.FK
    orgId?: IgOrg.id

    @db.rel.to
    org?: IgOrg

    @db.rel.from
    notes?: IgNote[]
}

@db.table 'ig_notes'
export interface IgNote {
    @meta.id
    id: number

    @db.rel.FK
    itemId: IgItem.id

    @db.rel.to
    item?: IgItem

    text: string
}
