// Primitive extensions as union / tuple members and array elements. Since
// atscript 0.1.103 their built-in annotations survive in those positions
// (`number.timestamp.created` → `@db.default.now`, `string.char` →
// `@expect.maxLength 1`); a member's annotations must not reach the column.
@db.table 'union_members'
export interface UnionMembers {
    @meta.id
    id: number

    x: number.timestamp.created | null

    y?: number.timestamp.created | null

    pair: [number.timestamp.created, string]

    emails: string.email[]

    n: number.int | null

    code: string.char | string

    created: number.timestamp.created
}
