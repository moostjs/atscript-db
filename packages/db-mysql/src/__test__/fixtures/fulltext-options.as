// Fixtures for fulltext-options.spec.ts (since 0.1.168).

@db.table 'fto_docs'
@db.index.fulltext.language "russian"
@db.index.fulltext.match "all"
export interface FtoDoc {
    @meta.id
    id: number

    @db.index.fulltext 'ft_body'
    body: string
}
