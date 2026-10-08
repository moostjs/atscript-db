// Fixtures for the 0.1.149 `resolveQuery` specs.

@db.table 'resolve_owners'
export interface ResolveOwner {
    @meta.id
    id: number

    name: string
}

@db.table 'resolve_issues'
export interface ResolveIssue {
    @meta.id
    id: number

    @db.index.unique 'code_idx'
    code: string

    ticketKey: string

    status: string

    @db.column.searchable
    title: string

    @db.writeOnly
    pin?: string

    contact?: {
        email?: string

        phone?: string

        @db.writeOnly
        secretPin?: string
    }

    @db.rel.FK
    ownerId?: ResolveOwner.id

    @db.rel.to
    owner?: ResolveOwner
}

// A plain interface — display-only fields for `@DbDecorations`.
export interface ResolveIssueDecorations {
    @meta.label 'Unread'
    unreadCount?: number.int
}

// No searchable column, no native search: a `$search` has nothing to apply to.
@db.table 'resolve_notes'
export interface ResolveNote {
    @meta.id
    id: number

    body: string
}

// A searchable integer column next to a searchable string (since 0.1.150).
@db.table 'resolve_refs'
export interface ResolveRef {
    @meta.id
    id: number

    @db.column.searchable
    title: string

    @db.column.searchable
    refNo: number.int
}

// A composite key.
@db.table 'resolve_lines'
export interface ResolveLine {
    @meta.id
    issueId: number

    @meta.id
    lineNo: number

    status: string
}

// No identity at all (stands in for an aggregate view): rows are ordered by `select`.
// `blob` is JSON-stored — not sortable.
@db.table 'resolve_loose'
export interface ResolveLoose {
    label: string

    @db.json
    blob: {
        a: string
    }
}

// A declared `preferredId`: rows are ordered by it, not by the primary key.
@db.table 'resolve_keyed'
@db.table.preferredId.uniqueIndex 'ref_idx'
export interface ResolveKeyed {
    @meta.id
    id: number

    @db.index.unique 'ref_idx'
    ref: string
}
