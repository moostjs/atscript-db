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

// fulltext-match.live.spec.ts (0.1.174): `match "all"` over two members.
@db.table 'fto_match_docs'
@db.index.fulltext.match "all"
export interface FtoMatchDoc {
    @meta.id
    id: number

    @db.index.fulltext 'ft_doc'
    title: string

    @db.index.fulltext 'ft_doc'
    body: string
}
