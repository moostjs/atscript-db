// Fixture for exists-null.spec.ts — optional @db.json object / array / scalar
// columns whose rows are written as object, `{}`, explicit null and absent.
@db.table 'exists_docs'
export interface ExistsDoc {
    @meta.id
    id: number

    label: string

    @db.json
    metrics?: {
        value?: number
    }

    tags?: string[]

    note?: string
}
