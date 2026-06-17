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

// SINGLE embedded object: the searchable fields live one level deep under
// `identity`. Atlas needs a nested `document` mapping node — a flattened
// "identity.name" key would match nothing. Queried with plain operators.
@db.table 'dealerGroups'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'dg_search'
export interface DealerGroup {
    @meta.id
    _id: string

    identity: {
        @db.mongo.search.autocomplete 'dg_search'
        name: string

        @db.mongo.search.text 'lucene.english', 'dg_search'
        tagline: string
    }
}

// ARRAY of embedded objects: `dealers.name` requires an `embeddedDocuments`
// mapping node and must be queried via the `embeddedDocument` operator (the
// wildcard `text` operator does not reach array-of-object fields).
@db.table 'dealerLists'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'dl_search'
export interface DealerList {
    @meta.id
    _id: string

    dealers: {
        @db.mongo.search.autocomplete 'dl_search'
        name: string

        @db.mongo.search.text 'lucene.english', 'dl_search'
        bio: string
    }[]
}

// MIXED nesting: array of objects, each with a single embedded object.
// `dealers.identity.name` → embeddedDocuments(dealers) > document(identity) > name.
@db.table 'dealerMixed'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'dm_search'
export interface DealerMixed {
    @meta.id
    _id: string

    dealers: {
        identity: {
            @db.mongo.search.autocomplete 'dm_search'
            name: string
        }
    }[]
}

// DOUBLY-nested arrays: an array of objects, each holding another array of objects.
// `regions.outlets.name` → embeddedDocuments(regions) > embeddedDocuments(regions.outlets)
// > name. The query needs one `embeddedDocument` operator per array level (nested).
@db.table 'dealerDeep'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'dd_search'
export interface DealerDeep {
    @meta.id
    _id: string

    regions: {
        outlets: {
            @db.mongo.search.autocomplete 'dd_search'
            name: string
        }[]
    }[]
}

// @db.column renames: MongoDB renames only the TOP-LEVEL document key, so the
// search mapping/query key must follow. `username`→`handle` (top-level field),
// and the embedded container `profile`→`prof` (top-level object); the nested
// leaf `bio` keeps its logical name (nested keys are stored as-is).
@db.table 'renamedSearch'
@db.mongo.collection
@db.mongo.search.static 'lucene.english', 1, 'rn_search'
export interface RenamedSearch {
    @meta.id
    _id: string

    @db.column 'handle'
    @db.mongo.search.autocomplete 'rn_search'
    username: string

    @db.column 'prof'
    profile: {
        @db.mongo.search.text 'lucene.english', 'rn_search'
        bio: string
    }
}
