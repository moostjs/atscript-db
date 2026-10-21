// Fulltext index names and relevance order (fulltext-names-rank.spec.ts). Since 0.1.165.

@db.table 'ft_plain'
@db.mongo.collection
export interface FtPlain {
    @meta.id
    _id: string

    @db.index.fulltext 'ft_plain_idx'
    title: string

    @db.index.fulltext 'ft_plain_idx'
    body: string
}
