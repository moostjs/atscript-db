import { Author } from './rel-author'
import { Post } from './test-relations'

@db.table 'comments'
export interface Comment {
    @meta.id
    @db.default.increment
    id: number

    body: string

    @db.default.now
    createdAt?: number.timestamp.created

    // ── Foreign Keys ─────────────────────────────────────────────
    @db.rel.FK
    @db.rel.onDelete 'cascade'
    postId: Post.id

    @db.rel.FK
    authorId?: Author.id

    // ── Relations ────────────────────────────────────────────────
    @db.rel.to
    post?: Post
}
