// Fixtures for the nested-decoration cases of declared-decorations.spec.ts:
// object and array-of-object sources read for a decoration hook.

@db.table 'deco_nested'
export interface DecoNested {
    @meta.id
    id: number

    title: string

    secret: {
        hash: string
        salt: string
    }

    contact: {
        phone: string
        email: string
    }

    @db.json
    items: {
        sku: string
        qty: number
    }[]
}

export interface DecoNestedDecorations {
    @meta.label 'Digest'
    digest?: string
}
