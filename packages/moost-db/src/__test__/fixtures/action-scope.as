// Fixture for actions-row-scope.spec.ts — an owner column (the row overlay),
// a status (gate state), a secret (hidden by the controller's hasField) and a
// derived copy of a JSON leaf whose source the controller hides.

@db.table 'scope_acts'
export interface ScopeAct {
    @meta.id
    id: number

    owner: string

    status: string

    secret: string

    @db.json
    meta?: {
        tag: string
    }

    @db.column.derived
    tagCopy?: ScopeAct.meta.tag
}
