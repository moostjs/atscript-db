// Fixture for with-in-read.spec.ts (since 0.1.196): relations read inside
// the root read by the adapter (`supportsWithInRead()`).

@db.table 'wm_teams'
export interface WmTeam {
    @meta.id
    id: number

    name: string

    @db.rel.from
    @db.rel.filterable
    members: WmMember[]
}

@db.table 'wm_members'
export interface WmMember {
    @meta.id
    id: number

    name: string

    role: string

    @db.rel.FK
    teamId: WmTeam.id

    @db.rel.to
    team?: WmTeam
}

@db.table 'wm_projects'
export interface WmProject {
    @meta.id
    id: number

    name: string

    @db.rel.store
    lead?: WmMember
}
