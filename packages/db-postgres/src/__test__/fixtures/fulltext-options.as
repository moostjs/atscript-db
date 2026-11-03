// Fixtures for fulltext-options.spec.ts (since 0.1.168).

@db.table 'fto_docs'
@db.index.fulltext.language "russian"
@db.index.fulltext.match "any", "ft_title"
@db.index.fulltext.match "all", "ft_body"
export interface FtoDoc {
    @meta.id
    id: number

    @db.index.fulltext 'ft_body'
    body: string

    @db.index.fulltext 'ft_title'
    title: string
}

@db.table 'fto_none'
@db.index.fulltext.language "none"
export interface FtoNone {
    @meta.id
    id: number

    @db.index.fulltext 'ft_body'
    body: string
}
