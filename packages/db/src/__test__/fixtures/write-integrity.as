// Write-path integrity (since 0.1.143): PK-first id resolution, nested-writer
// ownership rules and the post-write check hook.

// String PK next to a string unique key: a scalar id can name two rows.
@db.table 'wi_slugs'
export interface WiSlug {
    @meta.id
    id: string

    @db.index.unique 'wi_slug_idx'
    slug: string

    title: string

    @db.column.version
    version: number
}

@db.table 'wi_users'
export interface WiUser {
    @meta.id
    id: number

    name: string
}

@db.table 'wi_tags'
export interface WiTag {
    @meta.id
    @db.default.increment
    id: number

    name: string
}

@db.table 'wi_projects'
@db.depth.limit 1
export interface WiProject {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    ownerId?: WiUser.id

    @db.rel.to
    owner?: WiUser

    @db.rel.from
    notes?: WiNote[]

    @db.rel.via WiProjectTag
    tags?: WiTag[]

    @db.column.version
    version: number
}

@db.table 'wi_notes'
export interface WiNote {
    @meta.id
    id: number

    body: string

    @db.rel.FK
    projectId?: WiProject.id
}

@db.table 'wi_project_tags'
export interface WiProjectTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    projectId: WiProject.id

    @db.rel.FK
    tagId: WiTag.id
}

@db.table 'wi_counters'
export interface WiCounter {
    @meta.id
    @db.default.increment
    id: number

    name: string
}
