// Nested-write integrity on the memory adapter (no transactions): a rejected
// nested operation must never leave the main write applied (since 0.1.143).

@db.table 'ni_users'
export interface NiUser {
    @meta.id
    id: number

    name: string
}

@db.table 'ni_tags'
export interface NiTag {
    @meta.id
    @db.default.increment
    id: number

    name: string
}

@db.table 'ni_projects'
@db.depth.limit 1
export interface NiProject {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    ownerId?: NiUser.id

    @db.rel.to
    owner?: NiUser

    @db.rel.from
    notes?: NiNote[]

    @db.rel.via NiProjectTag
    tags?: NiTag[]

    @db.column.version
    version: number
}

@db.table 'ni_notes'
export interface NiNote {
    @meta.id
    id: number

    body: string

    @db.rel.FK
    projectId?: NiProject.id
}

@db.table 'ni_project_tags'
export interface NiProjectTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    projectId: NiProject.id

    @db.rel.FK
    tagId: NiTag.id
}
