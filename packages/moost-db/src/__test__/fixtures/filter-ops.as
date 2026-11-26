// Fixture for meta-filter-ops.spec.ts (since 0.1.196): an adapter's
// per-field operator lists (`filterOps(fd)`) in /meta and the request gate.

@db.table 'fo_suppliers'
export interface FoSupplier {
    @meta.id
    id: number

    name: string
}

@db.table 'fo_products'
export interface FoProduct {
    @meta.id
    id: number

    @db.column.searchable
    name: string

    sku: string

    rating?: number

    @db.column.searchable
    note?: string

    @db.writeOnly
    secret?: string

    @db.rel.FK
    supplierId?: FoSupplier.id

    @db.rel.to
    @db.rel.filterable
    supplier?: FoSupplier
}
