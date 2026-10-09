// Read / write paths of the 0.1.151 performance pass (perf-paths.spec.ts,
// perf-paths-server.spec.ts).

@db.table 'pf_authors'
export interface PfAuthor {
    @meta.id
    id: number

    @db.column.collate 'nocase'
    @db.index.unique 'pf_author_email'
    email: string

    @db.index.plain 'pf_author_name'
    name: string

    @db.column.collate 'unicode'
    @db.index.plain 'pf_author_city_name'
    city?: string

    @db.index.plain 'pf_author_city_name'
    rank?: number

    @db.rel.from
    posts?: PfPost[]
}

@db.table 'pf_posts'
export interface PfPost {
    @meta.id
    id: number

    title: string

    score?: number

    @db.rel.FK
    authorId?: PfAuthor.id

    @db.rel.to
    author?: PfAuthor
}

@db.table 'pf_tickets'
export interface PfTicket {
    @meta.id
    @db.default.increment
    id: number

    subject: string
}

@db.table 'pf_docs'
@db.mongo.collection
@db.mongo.search.dynamic 'lucene.standard'
export interface PfDoc {
    @meta.id
    _id: string

    title: string

    @db.search.vector 256, "cosine"
    embedding: number[]

    @db.search.filter "embedding"
    category: string

    @db.search.filter "embedding"
    year: number

    status: string
}
