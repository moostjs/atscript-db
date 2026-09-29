// Fixtures for actions-row-scope-hook.spec.ts and meta-available-actions.spec.ts
// — `actionRowScope` (the rows an action may run on: the gate, `$actions`,
// `GET /meta/actions/:id`): an owner column (the scope), a secret the
// controller hides with hasField, a composite-PK table, a preferredId table
// and a table whose unique slug can collide with another row's PK.

@db.table 'scope_hook_items'
export interface ScopeHookItem {
    @meta.id
    id: number

    owner: string

    status: string

    secret: string
}

@db.table 'scope_hook_lines'
export interface ScopeHookLine {
    @meta.id
    orderId: number

    @meta.id
    lineNo: number

    owner: string
}

// Addressed by `code` (preferredId), so a `$select` without `id` returns no id.
@db.table 'scope_hook_coded'
@db.table.preferredId.uniqueIndex 'code_idx'
export interface ScopeHookCoded {
    @meta.id
    id: number

    @db.index.unique 'code_idx'
    code: string

    owner: string
}

// A scalar id may be one row's PK and another row's unique slug.
@db.table 'scope_hook_slugs'
export interface ScopeHookSlug {
    @meta.id
    id: string

    @db.index.unique 'slug_idx'
    slug: string

    owner: string
}
