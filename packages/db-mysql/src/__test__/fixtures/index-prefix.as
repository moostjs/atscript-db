// Index members whose mapped types decide the key-length prefix
// (VARCHAR(n) within the limit → none; TEXT → 255; VARCHAR(1000) → 768).

@db.table 'ip_presets'
export interface IpPreset {
    @meta.id
    id: string

    @expect.maxLength 128
    @db.index.unique 'ip_slug'
    slug: string

    @db.index.plain 'ip_body'
    body: string

    @db.mysql.type "CHAR(36)"
    @db.index.plain 'ip_kind'
    kind: string

    @expect.maxLength 1000
    @db.index.unique 'ip_title'
    title: string

    @db.mysql.type "VARCHAR(64)"
    @db.index.plain 'ip_code'
    code: string

    @expect.maxLength 64
    @db.index.plain 'ip_pair'
    region: string

    @expect.maxLength 32
    @db.index.plain 'ip_pair'
    zone: string

    @db.index.plain 'ip_num'
    rank: number

    @db.index.fulltext 'ip_search'
    summary?: string
}
