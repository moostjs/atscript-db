// Fixture for safe-indexes-server.spec.ts — index changes that depend on a
// column change: a type change (the present-only unique filter is typed) and
// a nullability change (required → optional makes a unique index present-only).

@db.table 'safe_codes'
@db.sync.method 'drop'
export interface CodeText {
    @meta.id
    id: number

    @db.index.unique 'code_uq'
    code?: string
}

@db.table 'safe_codes'
@db.sync.method 'drop'
export interface CodeNumber {
    @meta.id
    id: number

    @db.index.unique 'code_uq'
    code?: number
}

@db.table 'safe_titles'
export interface TitleRequired {
    @meta.id
    id: number

    @db.index.unique 'title_uq'
    title: string
}

@db.table 'safe_titles'
export interface TitleOptional {
    @meta.id
    id: number

    @db.index.unique 'title_uq'
    title?: string
}
