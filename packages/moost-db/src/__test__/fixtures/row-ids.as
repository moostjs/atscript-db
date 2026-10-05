// Fixtures for row-id-resolution.spec.ts and action-gate-scope-first.spec.ts:
// a ticket with a renamable natural key (`code`, a unique index; the primary
// key stays the preferred id), a tenant column for row overlays, and a table
// addressed by its unique `code` (preferredId) so action ids are not
// primary-key shaped.

@db.table 'rid_tickets'
export interface RidTicket {
    @meta.id
    id: number

    @db.index.unique 'code_idx'
    code: string

    tenant: string

    status: string

    // A unique key the controller hides with hasField.
    @db.index.unique 'hidden_idx'
    hiddenKey: string
}

@db.table 'rid_coded'
@db.table.preferredId.uniqueIndex 'code_idx'
export interface RidCoded {
    @meta.id
    id: number

    @db.index.unique 'code_idx'
    code: string

    owner: string

    status: string
}
