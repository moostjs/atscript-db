import { User } from './restrict-user'

@db.table 'projects'
export interface Project {
    @meta.id
    @db.default.increment
    id: number

    title: string

    // ── Foreign Key ──────────────────────────────────────────────
    @db.rel.FK
    @db.rel.onDelete 'cascade'
    ownerId: User.id

    // ── Relations ────────────────────────────────────────────────
    @db.rel.to
    owner?: User
}
