// Fixture for readonly-file.spec.ts: a model served from a prebuilt read-only
// SQLite file, bound to its own space.

@db.table 'pack_articles'
@db.space 'pack'
@db.index.fulltext.language "english"
export interface PackArticle {
    @meta.id
    id: number

    @db.index.fulltext 'ft_text'
    title: string

    @db.index.fulltext 'ft_text'
    body: string
}
