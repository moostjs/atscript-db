// A referenced string column across the life of its foreign key
// (fk-reverse.live.spec.ts): referenced → no longer referenced (FK removed,
// referencing table removed) → TEXT again, and a unique string losing its
// @expect.maxLength.

@db.table 'fr_cats'
export interface FrCat {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'fr_slug_idx'
    slug: string

    label: string
}

@db.table 'fr_arts'
export interface FrArtRef {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    catSlug?: FrCat.slug

    note: string
}

// fr_arts without its foreign key
@db.table 'fr_arts'
export interface FrArtPlain {
    @meta.id
    @db.default.increment
    id: number

    catSlug?: string

    note: string
}

@db.table 'fr_codes'
export interface FrCodeSized {
    @meta.id
    @db.default.increment
    id: number

    @expect.maxLength 64
    @db.index.unique 'fr_code_idx'
    code: string
}

// fr_codes without the declared length
@db.table 'fr_codes'
export interface FrCodeText {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'fr_code_idx'
    code: string
}
