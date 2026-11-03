// Fixtures for fulltext-options.spec.ts (since 0.1.168). V1/V2 share a collection.

@db.table 'fto_docs'
export interface FtoDocV1 {
    @meta.id
    id: number

    @db.index.fulltext 'ft_body'
    body: string
}

@db.table 'fto_docs'
@db.index.fulltext.language "russian"
@db.index.fulltext.match "all"
export interface FtoDocV2 {
    @meta.id
    id: number

    @db.index.fulltext 'ft_body'
    body: string
}
