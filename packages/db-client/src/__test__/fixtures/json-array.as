// A @db.json array next to a plain array (json-array-preflight.spec.ts).
@db.table 'json_docs'
export interface JsonDoc {
    @meta.id
    id: number

    @db.json
    tags: string[]

    labels: string[]
}
