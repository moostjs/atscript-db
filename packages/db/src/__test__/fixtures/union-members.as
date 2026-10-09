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

@expect.maxLength 10
export type ShortCode = string

// A named alias member keeps contributing its own (non-db) annotations.
@db.table 'union_alias_members'
export interface UnionAliasMembers {
    @meta.id
    id: number

    short: ShortCode | string

    @db.default.now
    stamped: number.timestamp | null

    tsPair?: [number.timestamp.created, number.timestamp.created]
}
