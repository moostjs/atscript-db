// Fixtures for insert-representation.spec.ts (since 0.1.168).

@db.table 'irep_notes'
export interface IrepNote {
    @meta.id
    id: number

    title: string

    @db.default 'draft'
    status: string

    secret?: string

    tenant: string
}
