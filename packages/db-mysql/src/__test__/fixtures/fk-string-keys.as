// String columns on both sides of a foreign key (fk-string-keys.spec.ts).
// MySQL cannot key a TEXT column in full, so every string a foreign key
// uses (the referencing column and the referenced key) must be VARCHAR, of
// the same length on both sides.

@db.table 'fsk_slugged'
export interface FskSlugged {
    @meta.id
    @db.default.increment
    id: number

    // An optional unique string without a declared length
    @db.index.unique 'fsk_slug_idx'
    slug?: string

    // A unique string with a declared length
    @expect.maxLength 40
    @db.index.unique 'fsk_code_idx'
    code: string

    // A composite unique key of two strings
    @db.index.unique 'fsk_pair_idx'
    region: string

    @db.index.unique 'fsk_pair_idx'
    zone: string

    // Unique strings with their own collation / character set
    @db.column.collate 'nocase'
    @db.index.unique 'fsk_handle_idx'
    handle: string

    @db.mysql.charset 'ascii'
    @expect.maxLength 20
    @db.index.unique 'fsk_sku_idx'
    sku: string

    // A latin1 column is keyed in full up to 3072 characters
    @db.mysql.charset 'latin1'
    @expect.maxLength 1000
    @db.index.unique 'fsk_long_idx'
    longCode?: string

    // A string nothing references stays TEXT
    label: string
}

@db.table 'fsk_refs'
export interface FskRef {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'bySlug'
    sluggedSlug?: FskSlugged.slug

    // A plain index on the reference column: no key-length prefix
    @db.index.plain 'fsk_ref_code_idx'
    @db.rel.FK 'byCode'
    sluggedCode?: FskSlugged.code

    @db.rel.FK 'byPair'
    pairRegion?: FskSlugged.region

    @db.rel.FK 'byPair'
    pairZone?: FskSlugged.zone

    @db.rel.FK 'byHandle'
    sluggedHandle?: FskSlugged.handle

    @db.rel.FK 'bySku'
    sluggedSku?: FskSlugged.sku

    note: string
}

// String primary keys, without and with a declared length
@db.table 'fsk_plain_keys'
export interface FskPlainKey {
    @meta.id
    key: string

    label: string
}

@db.table 'fsk_sized_keys'
export interface FskSizedKey {
    @meta.id
    @expect.maxLength 64
    key: string

    label: string
}

@db.table 'fsk_key_refs'
export interface FskKeyRef {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'plain'
    plainKey?: FskPlainKey.key

    @db.rel.FK 'sized'
    sizedKey?: FskSizedKey.key
}

// A many-to-many link through a junction keyed by strings
@db.table 'fsk_posts'
export interface FskPost {
    @meta.id
    @expect.maxLength 36
    uid: string

    title: string

    @db.rel.via FskPostTag
    tags?: FskTag[]
}

@db.table 'fsk_tags'
export interface FskTag {
    @meta.id
    code: string

    @db.index.unique 'fsk_tag_name_idx'
    name: string
}

@db.table 'fsk_post_tags'
export interface FskPostTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    postUid: FskPost.uid

    @db.rel.FK
    tagCode: FskTag.code
}

// A referenced table in another character set
@db.table 'fsk_latin'
@db.mysql.charset 'latin1'
export interface FskLatin {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'fsk_latin_code_idx'
    code: string
}

@db.table 'fsk_latin_refs'
export interface FskLatinRef {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'plain'
    code?: FskLatin.code

    // Its own declarations are replaced by the referenced column's (warning)
    @db.mysql.charset 'utf8mb4'
    @db.column.collate 'binary'
    @db.rel.FK 'own'
    code2?: FskLatin.code
}

// fsk_tags with a declared length on `name`
@db.table 'fsk_tags'
export interface FskTagSized {
    @meta.id
    code: string

    @expect.maxLength 80
    @db.index.unique 'fsk_tag_name_idx'
    name: string
}
