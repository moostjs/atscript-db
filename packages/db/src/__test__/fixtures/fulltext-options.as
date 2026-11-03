// Fixtures for fulltext-options.spec.ts (since 0.1.168).

@db.table 'fto_articles'
@db.index.fulltext.language "russian"
@db.index.fulltext.language "none", "ft_tags"
@db.index.fulltext.match "any", "ft_title"
export interface FtoArticle {
    @meta.id
    id: number

    @db.index.fulltext "ft_body"
    body: string

    @db.index.fulltext "ft_title"
    title: string

    @db.index.fulltext "ft_tags"
    tags: string
}

@db.table 'fto_plain'
export interface FtoPlain {
    @meta.id
    id: number

    @db.index.fulltext "ft_body"
    body: string
}
