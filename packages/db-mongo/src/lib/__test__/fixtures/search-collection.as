// Fulltext-only table: its only text-search declaration is the portable
// `@db.index.fulltext`, which syncs to a CLASSIC MongoDB text index. search()
// must execute via classic `$text`, NOT Atlas `$search`.
@db.table 'articles'
@db.mongo.collection
export interface Article {
    @meta.id
    @db.default.increment
    id: number

    @db.index.fulltext 'articles_fts'
    title: string

    @db.index.fulltext 'articles_fts'
    body: string

    category: string
}

// Atlas dynamic search table: search() must execute via Atlas `$search`.
@db.table 'docs'
@db.mongo.collection
@db.mongo.search.dynamic 'lucene.standard'
export interface SearchDoc {
    @meta.id
    _id: string

    title: string
}

// Atlas static search with declared fuzzy + an autocomplete (prefix) field.
// `username` is double-mapped (autocomplete + string); `bio` is plain word match.
@db.table 'people'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'people'
export interface Person {
    @meta.id
    _id: string

    @db.mongo.search.autocomplete 'people'
    username: string

    @db.mongo.search.text 'lucene.english', 'people'
    bio: string
}

// Atlas static search with declared fuzzy but NO autocomplete field:
// search() stays a plain `text` operator (no compound), with fuzzy attached.
@db.table 'tickets'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 2, 'tickets'
export interface Ticket {
    @meta.id
    _id: string

    @db.mongo.search.text 'lucene.english', 'tickets'
    subject: string
}

// Blessed "same field, two behaviors" pattern: one central definition per index,
// the consumer picks per request via $index — NO query-time mode switching.
// `username` is word-matched (exact) in 'members_exact' and prefix-matched
// (typeahead + fuzzy) in 'members_prefix'.
@db.table 'members'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 0, 'members_exact'
@db.mongo.search.static 'lucene.english', 1, 'members_prefix'
export interface Member {
    @meta.id
    _id: string

    @db.mongo.search.text 'lucene.english', 'members_exact'
    @db.mongo.search.autocomplete 'members_prefix'
    username: string
}

// strategy 'autocomplete' — pure typeahead; single autocomplete field → a single
// autocomplete operator (no word-match clause, no compound).
@db.table 'handles'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 0, 'handles', 'autocomplete'
export interface Handle {
    @meta.id
    _id: string

    @db.mongo.search.autocomplete 'handles'
    nick: string
}

// strategy 'autocomplete' with TWO autocomplete fields → compound.should of
// autocomplete clauses only (still no text clause).
@db.table 'tags'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 0, 'tags', 'autocomplete'
export interface Tag {
    @meta.id
    _id: string

    @db.mongo.search.autocomplete 'tags'
    label: string

    @db.mongo.search.autocomplete 'tags'
    slug: string
}

// strategy 'text' — word matching only, even though the field is autocomplete-capable.
@db.table 'labels'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'labels', 'text'
export interface Label {
    @meta.id
    _id: string

    @db.mongo.search.autocomplete 'labels'
    name: string
}
