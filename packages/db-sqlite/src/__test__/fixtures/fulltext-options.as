// Fixtures for fulltext-options.spec.ts (since 0.1.168): `@db.index.fulltext.language` /
// `.match` on SQLite. The V1/V2 pair shares a table to test the tokenizer rebuild.

@db.table 'fto_plain'
export interface FtoPlain {
    @meta.id
    id: number

    @db.index.fulltext 'ft_body'
    body: string
}

@db.table 'fto_plain'
@db.index.fulltext.language "english"
export interface FtoEnglish {
    @meta.id
    id: number

    @db.index.fulltext 'ft_body'
    body: string
}

@db.table 'fto_any'
@db.index.fulltext.match "any"
export interface FtoAny {
    @meta.id
    id: number

    @db.index.fulltext 'ft_body'
    body: string
}

@db.table 'fto_russian'
@db.index.fulltext.language "russian"
export interface FtoRussian {
    @meta.id
    id: number

    @db.index.fulltext 'ft_body'
    body: string
}
