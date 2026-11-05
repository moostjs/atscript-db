// `@db.mysql.charset` without `@db.mysql.collate`, on a table and on columns.
@db.table 'cs_latin'
@db.mysql.charset "latin1"
export interface CsLatin {
    @meta.id
    id: number

    name: string
}

@db.table 'cs_latin_swedish'
@db.mysql.charset "latin1"
@db.mysql.collate "latin1_swedish_ci"
export interface CsLatinSwedish {
    @meta.id
    id: number

    name: string
}

@db.table 'cs_default'
export interface CsDefault {
    @meta.id
    id: number

    name: string
}

@db.table 'cs_columns'
export interface CsColumns {
    @meta.id
    id: number

    @db.mysql.charset "latin1"
    legacy: string

    @db.mysql.charset "latin1"
    @db.column.collate 'nocase'
    legacyNocase: string

    @db.mysql.charset "latin1"
    @db.mysql.collate "latin1_bin"
    legacyBin: string

    @db.mysql.charset "latin1"
    count: number

    plain: string
}
