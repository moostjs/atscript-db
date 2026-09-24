// Fixture for select-parent-exclusion.spec.ts — a nested object whose
// exclusion must drop the whole subtree.

@db.table 'px_docs'
export interface PxDoc {
    @meta.id
    id: number

    label: string

    secret: {
        hash: string
        salt: string
    }
}
