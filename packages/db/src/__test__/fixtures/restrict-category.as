import { User } from './restrict-user'

@db.table 'categories'
export interface Category {
    @meta.id
    @db.default.increment
    id: number

    label: string

    // ── Foreign Key ──────────────────────────────────────────────
    @db.rel.FK
    @db.rel.onDelete 'restrict'
    ownerId: User.id

    // ── Relations ────────────────────────────────────────────────
    @db.rel.to
    owner?: User
}
