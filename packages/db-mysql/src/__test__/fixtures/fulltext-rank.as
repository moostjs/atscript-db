// Fulltext index names and relevance order (fulltext-names-rank.spec.ts). Since 0.1.165.

@db.table 'ft_docs'
export interface FtDoc {
    @meta.id
    id: number.int

    @db.index.fulltext 'ft_body', 5
    title: string

    @db.index.fulltext 'ft_body'
    body: string

    @db.index.fulltext 'ft_tags'
    tags: string
}

@db.table 'ft_plain'
export interface FtPlain {
    @meta.id
    id: number.int

    @db.index.fulltext 'ft_plain_idx'
    title: string

    @db.index.fulltext 'ft_plain_idx'
    body: string
}
