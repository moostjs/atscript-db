import { Project } from './restrict-project'
import { Category } from './restrict-category'

@db.table 'users'
export interface User {
    @meta.id
    @db.default.increment
    id: number

    name: string

    // ── Relations ────────────────────────────────────────────────
    @db.rel.from
    projects?: Project[]

    @db.rel.from
    categories?: Category[]
}
