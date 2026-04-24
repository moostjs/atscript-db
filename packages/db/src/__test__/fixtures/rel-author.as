import { Post } from './test-relations'

@db.table 'authors'
@db.depth.limit 2
export interface Author {
    @meta.id
    @db.default.increment
    id: number

    name: string

    rating?: number

    @db.default.now
    createdAt?: number.timestamp.created

    // ── Relations ────────────────────────────────────────────────
    @db.rel.from
    posts?: Post[]
}
